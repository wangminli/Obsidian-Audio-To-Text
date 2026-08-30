# Audio to Text

[English](README.md) | [中文](README.zh-CN.md)

Audio to Text 是一个 Obsidian 插件，可以将笔记中引用的音频文件转换为 Markdown 文本。选中笔记中的音频引用，在编辑器右键菜单中选择转写命令，文字结果就会插入到该音频引用下方。

## 当前使用的转写模型

插件默认使用阿里云百炼（DashScope）的 **`qwen3-asr-flash-filetrans`** 模型。插件会提交异步文件转写任务，持续查询任务状态，下载带时间戳的识别结果，并按每分钟一段的方式写入笔记。

接口地址、模型名称和识别语言都可以在插件设置中修改。项目的服务适配层保持可扩展，未来可以支持更多云端服务、本地模型以及自建 API 网关，因此插件名称不会绑定某一个模型或服务商。

## 功能

- 选中音频引用后右键选择“语音转文本”。
- 可选的自动转文字：输入、粘贴或拖拽音频引用后自动开始转写。
- 支持 Obsidian Wiki 嵌入和普通 Markdown 音频链接。
- 根据模型返回的时间戳，按每分钟分段输出。
- 直接在音频引用下方写入标准 Markdown 文本。
- 音频会先上传到 Litterbox，生成临时公开下载地址后再提交异步转写任务；当上传服务接受该文件时，也可处理大于 10 MB 的录音。
- 如果音频引用下方已经存在转写结果，则跳过重复处理。

## 支持的引用格式

```md
![[recording.mp3]]
![[folder/meeting.m4a]]
[[recording.wav]]
[录音](recording.m4a)
```

## 输出示例

```md
![[meeting.m4a]]

### 语音转文本

**00:00 - 01:00**

这里是第一分钟的转写内容。

**01:00 - 02:00**

这里是第二分钟的转写内容。

---
```

标题和横线遵循插件当前的 Markdown 输出格式。旧版本生成的转写内容仍然可以被识别，以兼容已有笔记。

## 使用方法

1. 打开 **设置 → Audio to Text**，填写 DashScope API Key（或你配置的其他接口所需的密钥）。
2. 确认接口地址和模型名称。默认值分别是 DashScope 转写接口和 `qwen3-asr-flash-filetrans`。
3. 根据需要填写识别语言，例如 `zh` 或 `en`；留空时由模型自动识别。
4. 设置临时上传文件的保留时间。异步任务建议选择 `24h`。
5. 如果希望新插入的音频引用自动开始转写，请打开“自动转文字”。
6. 在 Markdown 编辑器中选中音频引用，点击右键菜单中的“语音转文本”，结果会插入到引用下方。

## 隐私与安全

- API Key 保存在 Obsidian 本地插件数据中，不会写入源码或控制台日志。不要将插件数据文件提交到公开仓库。
- 转写前，本地音频会上传到 Litterbox，并以公开下载地址的形式提交给模型服务。获得该地址的人可能可以在过期前访问文件。
- 除非你的安全策略允许临时上传到第三方服务，否则不要上传高度敏感、受监管或机密录音。
- Litterbox 的保留时间、文件大小限制、可用性和频率限制由上传服务决定；模型服务也有自己的音频时长和请求限制。

## 普通用户安装

普通用户**不需要**安装 Node.js，也不需要运行 `npm install` 或 `npm run build`。

插件正式发布到社区后，在 Obsidian 的 **设置 → 社区插件** 中搜索 **Audio to Text**，点击安装并启用即可。

在正式发布前，可以从项目 Release 下载预构建的 `main.js` 和 `manifest.json`，放入 Vault 的以下目录：

```text
.obsidian/plugins/qwen3-asr-audio-to-text/
```

然后在 Obsidian 的社区插件设置中重新加载插件。

## 本地开发

下面的命令只适用于修改源码或生成开发版插件的贡献者：

```bash
npm install
npm run build
```

开发时可以使用监听模式：

```bash
npm run dev
```

将生成的 `main.js` 和 `manifest.json` 复制到 Vault 插件目录后，即可在 Obsidian 中测试。

## 项目结构

- `main.ts`：插件源码。
- `main.js`：Obsidian 加载的构建文件。
- `manifest.json`：Obsidian 插件清单。
- `esbuild.config.mjs`：生产构建配置。

## 贡献

欢迎提交 Issue 和 Pull Request。新增服务适配时，请将服务配置、临时上传、请求适配、任务轮询和结果解析保持相互独立，并覆盖不同音频格式、长音频、临时上传失败和异步接口错误等场景。

## 赞助支持

如果这个插件对你有帮助，欢迎通过下面的收款码赞助支持后续开发：

<table>
  <tr>
    <td align="center"><img src="https://obsidian-geekwang-image-host.oss-cn-beijing.aliyuncs.com/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260830165317_168_132.jpg" alt="赞助收款码 1" width="240"></td>
    <td align="center"><img src="https://obsidian-geekwang-image-host.oss-cn-beijing.aliyuncs.com/%E5%BE%AE%E4%BF%A1%E5%9B%BE%E7%89%87_20260830165318_169_132.jpg" alt="赞助收款码 2" width="240"></td>
  </tr>
</table>

## 社区发布状态

项目正在准备提交 Obsidian 社区插件审核。当前插件 ID 仍为 `qwen3-asr-audio-to-text`，用于兼容已有本地安装。正式发布前，服务支持范围、错误处理、测试和发布文档仍可能继续完善。
