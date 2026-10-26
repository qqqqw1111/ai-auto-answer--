// ==UserScript==
// @name         AI自动答题助手（新道/DBE 学习平台通用）
// @namespace    https://edu.seentao.com/
// @version      1.2.0
// @description  自动识别页面题目（单选/多选/判断/填空），调用 OpenAI 兼容大模型 API 生成答案；支持整页批量连续作答、自动跳过已答题、自动/快捷键触发、重试与超时、调用计数统计。API密钥仅存本地油猴存储。
// @author       qqqqwlili
// @match        *://edu.seentao.com/*
// @match        *://*.seentao.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes     false
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 常量与默认配置 ================= */
  const DEFAULT_CFG = {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 1024,
    timeout: 60000,
    maxRetry: 3,
    triggerMode: 'manual', // 'auto' | 'manual'
    hotkey: 'ctrl+shift+a',
    autoSubmit: false,
    confirmMode: false,    // 默认不弹确认窗，直接填入
    panelSide: 'right',
  };

  const STAT = { called: 0, ok: 0, fail: 0, tokens: 0 };

  const cfg = loadCfg();
  function loadCfg() {
    const saved = GM_getValue('aa_cfg', {});
    return Object.assign({}, DEFAULT_CFG, saved);
  }
  function saveCfg() { GM_setValue('aa_cfg', cfg); refreshPanelFields(); }

  function loadStat() { const s = GM_getValue('aa_stat', null); if (s) Object.assign(STAT, s); renderStat(); }
  function saveStat() { GM_setValue('aa_stat', STAT); renderStat(); }

  /* ================= 工具函数 ================= */
  const log = (...a) => console.log('%c[AI答题]', 'color:#4f7cff', ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function toast(msg, type = 'info') {
    let box = document.getElementById('aa-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'aa-toast';
      box.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;' +
        'padding:10px 18px;border-radius:8px;color:#fff;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.25);' +
        'transition:opacity .3s;pointer-events:none;font-family:sans-serif;';
      document.body.appendChild(box);
    }
    box.style.background = type === 'error' ? '#e5484d' : type === 'ok' ? '#30a46c' : '#333';
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(() => box.style.opacity = '0', 2600);
  }

  function looksLikeStem(text) {
    if (!text || text.length < 6 || text.length > 2000) return false;
    return /(题|下列|以下|正确|错误|说法|描述|是指|属于|不属于|哪[个一]|[?？].*$|\( *\)|（ *）)/.test(text)
      || /\d+[.、．]/.test(text);
  }

  /* ================= 题目识别引擎 ================= */

  // 从 input/radio/checkbox 所在容器向上找题目区域，收集选项
  function extractFromInputs(root) {
    const inputs = root.querySelectorAll('input[type=radio],input[type=checkbox]');
    if (!inputs.length) return null;
    const groups = new Map();
    for (const inp of inputs) {
      let p = inp.closest('label,li,.el-radio,.el-checkbox,.ant-radio-wrapper,.ant-checkbox-wrapper,[class*=option],[class*=choice],[class*=item]') || inp.parentElement;
      if (!p) continue;
      const holder = p.parentElement || p;
      if (!groups.has(holder)) groups.set(holder, []);
      groups.get(holder).push({ inp, wrap: p });
    }
    let best = null;
    for (const [holder, arr] of groups) {
      if (!best || arr.length > best.arr.length) best = { holder, arr };
    }
    if (!best || best.arr.length < 2) return null;

    let stem = '';
    let node = best.holder;
    for (let up = 0; up < 4 && node && node !== document.body; up++) {
      const txt = directText(node.previousElementSibling || node.parentElement);
      if (looksLikeStem(txt)) { stem = txt; break; }
      node = node.parentElement;
    }
    if (!stem) return null;

    const type = best.arr[0].inp.type === 'radio' ? 'single' : 'multi';
    const options = best.arr.map(o => ({
      el: o.inp,
      wrap: o.wrap,
      label: (directText(o.wrap) || o.inp.value || '').trim().slice(0, 300),
      value: o.inp.value,
    }));
    return { stem: stem.trim(), type, options };
  }

  // 判断题：寻找"正确/错误"、"对/错"、"√/×"按钮
  function extractJudge(root) {
    const btns = [...root.querySelectorAll('button,label,.el-radio,.el-radio-button,[class*=option],[class*=judge],[class*=btn]')]
      .filter(b => /^(正确|错误|对|错|√|×)$/.test((directText(b) || '').trim()))
      .filter(b => b.offsetParent !== null);
    if (btns.length < 2) return null;
    let stem = '';
    let node = btns[0];
    for (let up = 0; up < 5 && node && node !== document.body; up++) {
      const holder = node.closest('div,section') || node;
      const txt = directText(holder.parentElement || holder);
      if (looksLikeStem(txt)) { stem = txt; break; }
      node = node.parentElement;
    }
    if (!stem) return null;
    return {
      stem: stem.trim(), type: 'judge',
      options: btns.map(b => ({ el: b, wrap: b, label: directText(b).trim(), value: directText(b).trim() })),
    };
  }

  // 填空题：题干附近有文本输入框
  function extractFill(root) {
    const texts = [...root.querySelectorAll('input[type=text],textarea')]
      .filter(i => i.offsetParent !== null && !i.readOnly && !i.disabled && i.type !== 'search')
      .filter(i => !i.closest('#aa-panel'));
    for (const inp of texts) {
      let node = inp;
      for (let up = 0; up < 5 && node && node !== document.body; up++) {
        const parent = node.parentElement;
        if (!parent) break;
        const txt = directText(parent);
        if (looksLikeStem(txt)) {
          return { stem: txt.trim(), type: 'fill', options: [], fillInputs: [inp] };
        }
        node = parent;
      }
    }
    return null;
  }

  // 获取节点文本
  function directText(el) {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 1500);
  }

  /* ============ 整页题块识别（v2 题干提取增强） ============ */
  function detectAllBlocks() {
    const inputs = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')]
      .filter(i => i.offsetParent !== null);
    const groups = new Map();
    for (const inp of inputs) {
      const wrap = inp.closest('label,li,.el-radio,.el-checkbox,[class*=option],[class*=choice],[class*=item]') || inp.parentElement;
      if (!wrap) continue;
      const holder = wrap.parentElement;
      if (!groups.has(holder)) groups.set(holder, []);
      groups.get(holder).push({ inp, wrap });
    }
    const blocks = [], seen = new Set();
    for (const [holder, arr] of groups) {
      if (arr.length < 2) continue;
      // 向上找同时包含题干和全部选项的最小容器，用"全文去掉选项部分"得到题干
      let stem = '';
      let node = holder;
      for (let up = 0; up < 5 && node && node !== document.body; up++) {
        const full = directText(node);
        const firstLabel = (directText(arr[0].wrap) || '').trim();
        if (firstLabel && full.includes(firstLabel)) {
          const head = full.slice(0, full.indexOf(firstLabel)).trim();
          if (head.length >= 6) { stem = head; break; }
        }
        node = node.parentElement;
      }
      if (!stem || seen.has(stem)) continue;   // 按题干去重，防止重复答题
      seen.add(stem);
      const type = arr[0].inp.type === 'radio' ? 'single' : 'multi';
      const m = stem.match(/(\d+)\s*[.、．]/);
      blocks.push({
        no: m ? m[1] : (blocks.length + 1),
        answered: arr.some(o => o.inp.checked),   // 有选中项即视为已作答
        q: {
          stem: stem.trim(), type,
          options: arr.map(o => ({ el: o.inp, wrap: o.wrap, label: (directText(o.wrap) || o.inp.value).trim().slice(0, 300), value: o.inp.value })),
        },
      });
    }
    // 按页面位置从上到下排序，确保不跳题
    blocks.sort((a, b) => (a.q.options[0].el.compareDocumentPosition(b.q.options[0].el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return blocks;
  }

  function detectQuestion() {
    const root = document;
    const q = extractFill(root) || extractFromInputs(root) || extractJudge(root);
    if (q) return q;
    const blocks = detectAllBlocks();
    const b = blocks.find(x => !x.answered) || blocks[0];
    return b ? b.q : null;
  }

  /* ================= 大模型调用（OpenAI 兼容格式） ================= */
  async function askLLM(question) {
    const letterList = question.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.label}`).join('\n');
    let prompt;
    if (question.type === 'single') {
      prompt = `你是答题助手。请从以下选项中选出唯一正确答案，只输出对应字母（如 B），不要任何解释。\n题目：${question.stem}\n${letterList}`;
    } else if (question.type === 'multi') {
      prompt = `你是答题助手。以下是多选题，请选出所有正确选项，只输出字母组合（如 ABD），不要任何解释。\n题目：${question.stem}\n${letterList}`;
    } else if (question.type === 'judge') {
      prompt = `你是答题助手。请判断以下说法是否正确。只输出「正确」或「错误」，不要任何解释。\n题目：${question.stem}`;
    } else {
      prompt = `你是答题助手。请直接给出填空答案，简短准确，不要解释。\n题目：${question.stem}`;
    }

    const body = {
      model: cfg.model,
      temperature: Number(cfg.temperature),
      max_tokens: Number(cfg.maxTokens),
      messages: [
        { role: 'system', content: '你是一个精确的中文答题助手，严格按用户要求格式输出。' },
        { role: 'user', content: prompt },
      ],
    };

    let lastErr = null;
    for (let attempt = 1; attempt <= cfg.maxRetry; attempt++) {
      STAT.called++; saveStat();
      try {
        const res = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: cfg.apiUrl,
            timeout: Number(cfg.timeout),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cfg.apiKey}`,
            },
            data: JSON.stringify(body),
            onload: r => {
              try {
                const j = JSON.parse(r.responseText);
                if (r.status >= 200 && r.status < 300) resolve(j);
                else reject(new Error(`HTTP ${r.status}: ${(j.error && j.error.message) || r.responseText.slice(0, 200)}`));
              } catch (e) { reject(new Error('响应解析失败: ' + r.responseText.slice(0, 200))); }
            },
            onerror: () => reject(new Error('网络错误（检查 API 地址/网络/跨域配置）')),
            ontimeout: () => reject(new Error(`请求超时（${cfg.timeout}ms）`)),
          });
        });
        const answer = (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content || '').trim();
        STAT.tokens += (res.usage && res.usage.total_tokens) || 0;
        STAT.ok++; saveStat();
        log('LLM 原始返回:', answer);
        return answer;
      } catch (e) {
        lastErr = e; STAT.fail++; saveStat();
        log(`第${attempt}次调用失败:`, e.message);
        if (attempt < cfg.maxRetry) await sleep(1000 * attempt);
      }
    }
    throw lastErr || new Error('未知错误');
  }

  /* ================= 答案解析与填充 ================= */
  function parseAnswer(question, raw) {
    raw = raw.replace(/^[^\w对错正误]*/, '').trim();
    if (question.type === 'single' || question.type === 'multi') {
      const letters = (raw.match(/[A-Z]/g) || []).filter(l =>
        l.charCodeAt(0) - 65 < question.options.length);
      return { kind: 'choice', letters: [...new Set(letters)] };
    }
    if (question.type === 'judge') {
      if (/错|不正确|×|false|F\b/i.test(raw)) return { kind: 'judge', val: '错误' };
      return { kind: 'judge', val: '正确' };
    }
    return { kind: 'fill', val: raw };
  }

  function applyAnswer(question, parsed) {
    if (parsed.kind === 'choice') {
      for (const l of parsed.letters) {
        const opt = question.options[l.charCodeAt(0) - 65];
        if (!opt) continue;
        if (opt.el.type === 'radio' || opt.el.type === 'checkbox') {
          if (!opt.el.checked) opt.el.click();
        } else {
          opt.wrap.click();
        }
      }
      return `已选择: ${parsed.letters.join(', ')}`;
    }
    if (parsed.kind === 'judge') {
      const target = question.options.find(o => o.label.includes(parsed.val.slice(0, 1)) || o.label.includes(parsed.val));
      if (target) { target.el.click(); return `已判断: ${parsed.val}`; }
      return `页面未找到「${parsed.val}」按钮，请手动选择`;
    }
    if (parsed.kind === 'fill' && question.fillInputs && question.fillInputs.length) {
      const inp = question.fillInputs[0];
      setNativeValue(inp, parsed.val);
      return `已填入: ${parsed.val}`;
    }
    return '未能自动填充';
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ================= 主流程：单题 ================= */
  let busy = false;
  async function runOnce() {
    if (busy) { toast('正在处理中，请稍候', 'info'); return; }
    if (!cfg.apiKey) { toast('请先在设置面板填写 API Key', 'error'); openPanel(); return; }
    busy = true;
    setBtnStatus('识别题目中...');
    try {
      const q = detectQuestion();
      if (!q) { toast('未识别到题目结构，按F12查看Console日志并反馈', 'error'); return; }
      log('识别到题目:', q);
      setBtnStatus(`调用模型(${cfg.model})...`);
      const raw = await askLLM(q);
      const parsed = parseAnswer(q, raw);
      const desc = parsed.kind === 'choice' ? parsed.letters.join('') : parsed.val;

      if (cfg.confirmMode) {
        const ok = window.confirm(`AI 答案：${desc}\n\n题干：${q.stem.slice(0, 120)}...\n\n是否填入？`);
        if (!ok) { toast('已取消填入'); return; }
      }
      const result = applyAnswer(q, parsed);
      toast(result, 'ok');

      if (cfg.autoSubmit && !cfg.confirmMode) {
        const submitBtn = [...document.querySelectorAll('button')].find(b =>
          /提交|^确定$|交卷|下一题/.test((b.innerText || '').trim()) && b.offsetParent !== null);
        if (submitBtn) { await sleep(600); submitBtn.click(); log('已点击提交按钮'); }
      }
    } catch (e) {
      toast('答题失败：' + e.message, 'error');
    } finally {
      busy = false;
      setBtnStatus('');
    }
  }

  /* ================= 主流程：整页批量连续作答 ================= */
  async function runBatch() {
    if (busy) { toast('正在处理中，请稍候', 'info'); return; }
    if (!cfg.apiKey) { toast('请先在设置面板填写 API Key', 'error'); openPanel(); return; }
    busy = true;
    try {
      const blocks = detectAllBlocks();
      log('识别到题块:', blocks);
      if (!blocks.length) { toast('未识别到题目', 'error'); return; }
      const todo = blocks.filter(b => !b.answered);
      if (!todo.length) { toast('全部题目均已作答，无待答题目', 'ok'); return; }
      let ok = 0, fail = 0;
      for (const b of todo) {
        setBtnStatus(`第 ${b.no} 题（${ok + fail + 1}/${todo.length}）调用模型...`);
        try {
          const raw = await askLLM(b.q);
          const parsed = parseAnswer(b.q, raw);
          applyAnswer(b.q, parsed);
          ok++;
        } catch (e) {
          fail++;
          log(`第 ${b.no} 题失败:`, e.message);
        }
        await sleep(800); // 等 UI 刷新再处理下一题，避免状态错乱
      }
      toast(`批量完成：成功 ${ok} 题${fail ? `，失败 ${fail} 题（可重试，已答的会自动跳过）` : ''}`, fail ? 'error' : 'ok');
    } finally {
      busy = false;
      setBtnStatus('');
    }
  }

  /* ================= 悬浮按钮与配置面板 ================= */
  function buildUI() {
    if (document.getElementById('aa-panel')) return;

    const ball = document.createElement('div');
    ball.id = 'aa-ball';
    ball.textContent = 'AI';
    ball.title = '单击=批量答题 | 双击=设置';
    ball.style.cssText = `position:fixed;${cfg.panelSide}:24px;bottom:90px;z-index:999998;width:52px;height:52px;` +
      'border-radius:50%;background:linear-gradient(135deg,#4f7cff,#8b5cf6);color:#fff;display:flex;' +
      'align-items:center;justify-content:center;font-weight:bold;font-size:15px;cursor:pointer;' +
      'box-shadow:0 4px 16px rgba(79,124,255,.45);user-select:none;font-family:sans-serif;';
    ball.addEventListener('click', () => { if (!busy) runBatch(); });
    ball.addEventListener('dblclick', openPanel);
    document.body.appendChild(ball);

    const status = document.createElement('div');
    status.id = 'aa-status';
    status.style.cssText = `position:fixed;${cfg.panelSide}:24px;bottom:70px;z-index:999998;font-size:12px;` +
      'color:#4f7cff;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:2px 8px;display:none;';
    document.body.appendChild(status);

    buildPanel();
    loadStat();
  }

  function setBtnStatus(text) {
    const s = document.getElementById('aa-status');
    if (!s) return;
    s.textContent = text;
    s.style.display = text ? 'block' : 'none';
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'aa-panel';
    panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;' +
      'width:480px;max-width:92vw;max-height:86vh;overflow:auto;background:#fff;border-radius:12px;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.28);font-family:sans-serif;font-size:13px;color:#333;display:none;';
    panel.innerHTML = `
      <div style="padding:14px 18px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
        <b style="font-size:15px;">AI 答题助手 · 设置</b>
        <span id="aa-close" style="cursor:pointer;font-size:20px;color:#999;">×</span>
      </div>
      <div style="padding:14px 18px;display:grid;gap:10px;">
        <label>API 地址（OpenAI 兼容 /v1/chat/completions）
          <input id="aa-apiUrl" style="${IPT}" placeholder="https://api.deepseek.com/v1/chat/completions">
        </label>
        <label>API Key（仅存本地油猴存储，不上传第三方）
          <input id="aa-apiKey" type="password" style="${IPT}" placeholder="sk-...">
        </label>
        <label>模型名称
          <input id="aa-model" style="${IPT}" placeholder="deepseek-flash / deepseek-v4-pro / gpt-4o-mini ...">
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <label>temperature<input id="aa-temperature" style="${IPT}" type="number" step="0.1" min="0" max="2"></label>
          <label>超时(ms)<input id="aa-timeout" style="${IPT}" type="number" step="1000"></label>
          <label>重试次数<input id="aa-maxRetry" style="${IPT}" type="number" min="1" max="10"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <label>触发方式
            <select id="aa-triggerMode" style="${IPT}">
              <option value="manual">手动（快捷键/点击悬浮球）</option>
              <option value="auto">自动（检测到题目即答）</option>
            </select>
          </label>
          <label>快捷键
            <select id="aa-hotkey" style="${IPT}">
              <option value="ctrl+shift+a">Ctrl+Shift+A</option>
              <option value="alt+a">Alt+A</option>
              <option value="ctrl+alt+a">Ctrl+Alt+A</option>
            </select>
          </label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <label>填入前确认
            <select id="aa-confirmMode" style="${IPT}">
              <option value="true">开启（弹窗确认）</option>
              <option value="false">关闭（直接填入）</option>
            </select>
          </label>
          <label>自动提交
            <select id="aa-autoSubmit" style="${IPT}">
              <option value="false">关闭（推荐）</option>
              <option value="true">开启（风险自负）</option>
            </select>
          </label>
        </div>
        <div style="background:#f6f7fb;border-radius:8px;padding:10px 12px;" id="aa-statBox"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="aa-save" style="${BTN}background:#4f7cff;color:#fff;">保存配置</button>
          <button id="aa-export" style="${BTN}">导出配置</button>
          <button id="aa-import" style="${BTN}">导入配置</button>
          <button id="aa-clearStat" style="${BTN}">清零统计</button>
          <button id="aa-test" style="${BTN}">测试连接</button>
        </div>
        <div id="aa-importArea" style="display:none;">
          <textarea id="aa-importText" style="${IPT}height:70px;" placeholder="粘贴导出的配置 JSON"></textarea>
          <button id="aa-importOk" style="${BTN}margin-top:6px;background:#30a46c;color:#fff;">确认导入</button>
        </div>
        <div style="color:#999;font-size:11px;line-height:1.6;">
          ⚠️ 安全提示：API 密钥仅保存在本机浏览器油猴存储中，请自行保管并注意 API 调用费用。
          请遵守平台规则与考试纪律，本工具仅供学习辅助。
        </div>
      </div>`;
    document.body.appendChild(panel);
    bindPanel(panel);
  }

  const IPT = 'width:100%;box-sizing:border-box;margin-top:3px;padding:6px 8px;border:1px solid #d9dce3;border-radius:6px;font-size:13px;';
  const BTN = 'padding:6px 12px;border:1px solid #d9dce3;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;';

  function bindPanel(panel) {
    panel.querySelector('#aa-close').onclick = () => panel.style.display = 'none';
    panel.querySelector('#aa-save').onclick = () => {
      cfg.apiUrl = panel.querySelector('#aa-apiUrl').value.trim() || DEFAULT_CFG.apiUrl;
      cfg.apiKey = panel.querySelector('#aa-apiKey').value.trim();
      cfg.model = panel.querySelector('#aa-model').value.trim() || DEFAULT_CFG.model;
      cfg.temperature = panel.querySelector('#aa-temperature').value;
      cfg.timeout = panel.querySelector('#aa-timeout').value;
      cfg.maxRetry = panel.querySelector('#aa-maxRetry').value;
      cfg.triggerMode = panel.querySelector('#aa-triggerMode').value;
      cfg.hotkey = panel.querySelector('#aa-hotkey').value;
      cfg.confirmMode = panel.querySelector('#aa-confirmMode').value === 'true';
      cfg.autoSubmit = panel.querySelector('#aa-autoSubmit').value === 'true';
      saveCfg();
      toast('配置已保存（仅本地）', 'ok');
    };
    panel.querySelector('#aa-export').onclick = () => {
      const exp = { ...cfg, apiKey: '' };
      const withKey = window.confirm('导出内容是否包含 API Key？\n（确定=包含，取消=不含密钥）');
      if (withKey) exp.apiKey = cfg.apiKey;
      const json = JSON.stringify(exp, null, 2);
      panel.querySelector('#aa-importArea').style.display = 'block';
      panel.querySelector('#aa-importText').value = json;
      navigator.clipboard && navigator.clipboard.writeText(json);
      toast('配置已生成并可复制，可保存为 json 文件传到其他设备', 'ok');
    };
    panel.querySelector('#aa-import').onclick = () => {
      const area = panel.querySelector('#aa-importArea');
      area.style.display = area.style.display === 'none' ? 'block' : 'none';
    };
    panel.querySelector('#aa-importOk').onclick = () => {
      try {
        const obj = JSON.parse(panel.querySelector('#aa-importText').value);
        Object.assign(cfg, obj);
        saveCfg();
        toast('配置导入成功', 'ok');
        panel.style.display = 'none';
      } catch (e) { toast('JSON 解析失败：' + e.message, 'error'); }
    };
    panel.querySelector('#aa-clearStat').onclick = () => {
      STAT.called = 0; STAT.ok = 0; STAT.fail = 0; STAT.tokens = 0; saveStat(); toast('统计已清零');
    };
    panel.querySelector('#aa-test').onclick = async () => {
      const key = panel.querySelector('#aa-apiKey').value.trim();
      const url = panel.querySelector('#aa-apiUrl').value.trim() || cfg.apiUrl;
      const model = panel.querySelector('#aa-model').value.trim() || cfg.model;
      if (!key) { toast('请先填写 API Key', 'error'); return; }
      toast('测试请求中...');
      GM_xmlhttpRequest({
        method: 'POST', url, timeout: 20000,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        data: JSON.stringify({ model, messages: [{ role: 'user', content: '回复"ok"两个字母即可' }], max_tokens: 8 }),
        onload: r => {
          if (r.status >= 200 && r.status < 300) toast('连接成功，模型可用 ✓', 'ok');
          else toast(`连接失败 HTTP ${r.status}: ${r.responseText.slice(0, 120)}`, 'error');
        },
        onerror: () => toast('网络错误，检查地址/网络', 'error'),
        ontimeout: () => toast('测试超时', 'error'),
      });
    };
    refreshPanelFields();
  }

  function refreshPanelFields() {
    const panel = document.getElementById('aa-panel');
    if (!panel) return;
    const set = (id, v) => { const el = panel.querySelector(id); if (el) el.value = v; };
    set('#aa-apiUrl', cfg.apiUrl);
    set('#aa-apiKey', cfg.apiKey);
    set('#aa-model', cfg.model);
    set('#aa-temperature', cfg.temperature);
    set('#aa-timeout', cfg.timeout);
    set('#aa-maxRetry', cfg.maxRetry);
    set('#aa-triggerMode', cfg.triggerMode);
    set('#aa-hotkey', cfg.hotkey);
    set('#aa-confirmMode', String(cfg.confirmMode));
    set('#aa-autoSubmit', String(cfg.autoSubmit));
  }

  function renderStat() {
    const box = document.getElementById('aa-statBox');
    if (!box) return;
    box.innerHTML = `<b>📊 调用统计</b>&nbsp; 总调用: <b>${STAT.called}</b> | 成功: <b style="color:#30a46c">${STAT.ok}</b> | 失败: <b style="color:#e5484d">${STAT.fail}</b> | 累计 tokens: <b>${STAT.tokens}</b>`;
  }

  function openPanel() {
    const panel = document.getElementById('aa-panel');
    if (panel) { refreshPanelFields(); renderStat(); panel.style.display = 'block'; }
  }

  /* ================= 快捷键 & 自动模式 ================= */
  function hotkeyMatch(e) {
    const parts = cfg.hotkey.split('+');
    const key = parts[parts.length - 1].toLowerCase();
    const needCtrl = parts.includes('ctrl'), needAlt = parts.includes('alt'), needShift = parts.includes('shift');
    return e.key.toLowerCase() === key && e.ctrlKey === needCtrl && e.altKey === needAlt && e.shiftKey === needShift;
  }

  document.addEventListener('keydown', e => {
    if (hotkeyMatch(e)) { e.preventDefault(); runBatch(); }
  }, true);

  // 自动模式：MutationObserver 防抖检测新题目
  let autoTimer = null, lastStem = '';
  const mo = new MutationObserver(() => {
    if (cfg.triggerMode !== 'auto' || busy) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      const blocks = detectAllBlocks();
      const todo = blocks.filter(b => !b.answered);
      if (todo.length) {
        const sig = todo.map(b => b.q.stem).join('|').slice(0, 500);
        if (sig !== lastStem) {
          lastStem = sig;
          log('自动模式检测到待答题目，开始批量作答');
          runBatch();
        }
      }
    }, 1500);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  /* ================= 菜单命令 ================= */
  GM_registerMenuCommand('⚙️ 打开设置面板', openPanel);
  GM_registerMenuCommand('▶️ 答当前题', runOnce);
  GM_registerMenuCommand('📋 批量连续答题（整页）', runBatch);

  /* ================= 启动 ================= */
  function boot() {
    if (document.body) buildUI();
    else setTimeout(boot, 500);
  }
  boot();
})();
