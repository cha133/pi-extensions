import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

// getShellConfig 要求 existsSync 能命中，所以必须用绝对路径，不能写裸 "pwsh.exe"。
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

/**
 * 用 pwsh7 覆盖内置 bash 工具：
 * - shellPath 指向 pwsh7（覆盖后内置工具从 settings 读 shellPath 的逻辑不再生效，必须显式传）
 * - spawnHook 注入 TERM=dumb：
 *   1) 触发 $profile 顶部 `if ($env:TERM -eq 'dumb') { return }` 提前返回，
 *      跳过 starship / PSReadLine / zoxide 等交互式初始化，只保留 UTF-8 编码 + mise activate；
 *   2) 让 git / eza 等检测到 dumb 终端，不吐 ANSI 转义。
 * - promptGuidelines 抄自 ~/.agents/AGENTS.md，提醒模型写 pwsh7 语法而非 bash。
 * 其余（execute / 50KB·2000 行截断 / 流式节流 / TUI 渲染 / 超时 / 进程树 kill）全复用内置实现。
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const base = createBashTool(ctx.cwd, {
			shellPath: PWSH,
			spawnHook: ({ command, cwd, env }) => ({
				command,
				cwd,
				env: { ...env, TERM: "dumb" },
			}),
		});

		pi.registerTool({
			...base,
			name: "bash", // 同名覆盖内置 bash 工具（TUI 会显示一条覆盖警告）
			description:
				"在当前工作目录执行 PowerShell 7 (pwsh) 命令，返回 stdout 和 stderr。" +
				"输出截断到最后 2000 行或 50KB，超出部分存到临时文件并在结果里给出路径。" +
				"可提供 timeout（秒）。环境已注入 TERM=dumb；$profile 自动加载，mise 环境与 UTF-8 编码就绪。",
			promptSnippet: "执行 pwsh7 命令",
			promptGuidelines: [
				"bash 工具运行的是 pwsh7，写 PowerShell 7 语法，不要写 bash/sh：环境变量用 `$env:NAME = 'x'`（不是 `export`）、行连续用反引号（不是 `\\`）、测试存在用 `Test-Path`（不是 `[ -f ]`）、路径带空格调用 exe 用 `& 'C:\\path\\app.exe' arg`。",
				"搜索优先用已装的 CLI 而不是 Unix 工具：用 `fd` 找文件（如 `fd -e md` 找所有 markdown，不是 `find`），用 `rg` 搜内容（不是 `grep`/`Select-String`）；截断输出用 `Select-Object -First N` / `-Last N`（不是 `head` / `tail`，也可 `Get-Content -TotalCount N` / `-Tail N`），统计行数用 `(Get-Content f | Measure-Object -Line).Lines`（不是 `wc -l`），查命令路径用 `(Get-Command name).Source`（不是 `which`）。",
				"给原生 exe 传多行参数（如 git commit message）用 here-string：`@'...'@`（单引号不展开变量）或 `@\"...\"@`（展开变量）；闭合标记 `'@` / `\"@` 必须顶格（行首无缩进），否则报错。",
				"命令替换用 `$(cmd)`；`&&` / `||` 在 pwsh7 支持；管道传递的是对象不是文本。",
				"临时脚本优先写 js 到 `$env:TEMP` 用 bun 运行（如 `bun \"$env:TEMP\\scratch.js\"`），不要写 python/pwsh/bash 脚本；跑 .ps1 用 pwsh.exe（不是 powershell.exe），跑 .sh 用 sh.exe（不是 bash.exe）。",
			],
		});
	});
}
