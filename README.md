# AI 自动答题助手（Tampermonkey 油猴脚本）

针对新道 DBE 学习平台（edu.seentao.com）的 AI 辅助答题油猴脚本。自动识别页面题目（单选/多选/判断/填空），调用 OpenAI 兼容大模型 API 生成答案并自动填入，支持整页批量连续作答。

## 功能特性

- 题型识别：单选、多选、判断、填空，兼容 SPA 动态渲染
- 整页批量作答：逐题「调用模型 → 自动点选 → 下一题」，已答题自动跳过，失败可重跑
- 模型接入：任意 OpenAI 兼容 API（DeepSeek / 通义千问 / 智谱 / Kimi / GPT / Claude 兼容代理等）
- 稳定性：指数退避重试、超时控制、调用计数统计（成功/失败/累计 tokens）
- 触发方式：悬浮球单击（批量）、快捷键 `Ctrl+Shift+A`、自动模式（检测到题目即答）
- 配置管理：可视化面板，配置导出/导入 JSON，便于多设备复用

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（4.0+）
2. 下载 `ai-auto-answer.user.js`
3. 打开 Tampermonkey → 「添加新脚本」→ 粘贴全部代码 → `Ctrl+S` 保存
   （或直接把 `.user.js` 文件拖入浏览器安装）

一键安装链接：

```
https://raw.githubusercontent.com/qqqqwlili/ai-auto-answer-/main/ai-auto-answer.user.js
```

## 配置

双击页面右下角 AI 悬浮球打开设置面板：

| 字段 | 示例 |
|---|---|
| API 地址 | `https://api.deepseek.com/v1/chat/completions` |
| API Key | `sk-...`（服务商控制台创建） |
| 模型名称 | `deepseek-flash` / `deepseek-v4-pro` / `gpt-4o-mini` |

填完点「测试连接」→「保存配置」。

## 使用

| 操作 | 说明 |
|---|---|
| 单击 AI 悬浮球 | 批量作答整页所有未答题 |
| 快捷键 `Ctrl+Shift+A` | 同上 |
| 双击 AI 悬浮球 | 打开设置面板 |
| Tampermonkey 菜单 | 「答当前题」「批量连续答题（整页）」「设置」 |

## 多设备同步

1. **配置导出/导入**：设置面板 → 导出配置（可选是否含 Key）→ JSON 粘贴到新设备导入
2. **Tampermonkey 同步**：浏览器账号同步 / Tampermonkey 云同步（Google Drive、OneDrive）

## 安全说明

- API 密钥仅存储在本地浏览器油猴存储（GM_setValue）中，脚本无任何上报逻辑
- 大模型 API 按 token 计费，请自行关注调用成本
- 请遵守平台规则与考试纪律，本工具仅供学习辅助，正式考试使用后果自负

## License

MIT
