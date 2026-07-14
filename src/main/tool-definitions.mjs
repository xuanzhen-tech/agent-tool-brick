/**
 * agent-tool 暴露给模型的工具定义。
 *
 * 本文件包含通过工具 manifest 对外公布的公共 tool schema。运行时实现位于
 * 相邻模块；把 schema 集中在这里，便于审计模型合同，而不需要一路追踪
 * 执行代码。
 */

const SHELL_CONTEXT = createShellContext(process.platform);
const SHELL_CONTEXT_DESCRIPTION = [
  `当前操作系统：${SHELL_CONTEXT.osLabel}（${SHELL_CONTEXT.platform}）。`,
  `mode='shell' 会通过 ${SHELL_CONTEXT.shellCommand} 执行；请使用 ${SHELL_CONTEXT.syntaxLabel} 语法。`,
  SHELL_CONTEXT.syntaxHint
].join(" ");

function createShellContext(platform) {
  if (platform === "win32") {
    return {
      platform,
      osLabel: "Windows",
      shellCommand: "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command",
      syntaxLabel: "PowerShell",
      syntaxHint: "环境变量使用 $env:NAME；依赖 shell 内建能力时请使用 PowerShell 管道、条件语句和 Get-ChildItem、Select-String 等 PowerShell 命令。"
    };
  }
  return {
    platform,
    osLabel: platform === "darwin" ? "macOS" : "Linux/Unix",
    shellCommand: "/bin/bash -lc",
    syntaxLabel: "bash/POSIX shell",
    syntaxHint: "环境变量使用 $NAME；依赖 shell 内建能力时请使用 POSIX shell 的管道、条件语句和标准 Unix 命令语法。"
  };
}

export const RUN_SHELL_TOOL = {
  name: "run_shell",
  description: [
    "默认且优先使用的一次性终端工具：在当前 workspace 执行应在本次调用内结束的命令，带有超时、取消和输出大小限制。",
    SHELL_CONTEXT_DESCRIPTION,
    "普通文件读写、Python、Node、git、npm、npx 和一次性脚本都优先使用本工具；Python、Node 等优先使用 mode='process'，这样 executable、args 和 stdin 不需要 shell 转义。",
    `只有必须使用 ${SHELL_CONTEXT.syntaxLabel} 的管道、变量、重定向或条件语句时才使用 mode='shell'。`,
    "生成正式交付文件时必须写入 outputs/：在同一命令中创建缺失目录、以 UTF-8 写入、并验证目标文件存在。命令失败、超时或未验证成功时，不得宣称任务已完成。",
    "除非用户明确要求且已核验目标路径，否则不要执行破坏性文件操作。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "run_shell",
      description: [
        "默认的一次性终端工具。用于普通文件读写、脚本、Python、Node、git、npm 和短时命令；不用于持续运行的服务或交互式终端。",
        SHELL_CONTEXT_DESCRIPTION
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["process", "shell"],
            description: `执行模式。Python、Node、git 等使用 process 传递 argv/stdin；只有需要 ${SHELL_CONTEXT.syntaxLabel} 语法时才使用 shell（${SHELL_CONTEXT.shellCommand}）。`
          },
          command: {
            type: "string",
            description: `mode=shell 的命令。${SHELL_CONTEXT.osLabel} 上必须使用 ${SHELL_CONTEXT.syntaxLabel} 语法。正式输出需在命令内创建 outputs/、使用 UTF-8，并验证文件存在。`
          },
          executable: {
            type: "string",
            description: "mode=process 的可执行程序，例如 node、python、git、npm 或 npx。"
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "mode=process 的参数数组。"
          },
          stdin: {
            type: "string",
            description: "mode=process 的可选 stdin。"
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "可选超时覆盖值，单位毫秒。"
          }
        }
      }
    }
  },
  permissions: ["process.exec"],
  timeoutMs: 20_000,
  cancelable: true
};

export const EXEC_COMMAND_TOOL = {
  name: "exec_command",
  description: [
    "仅用于持续运行的终端进程：启动命令后，如果它仍在运行，会快速返回 session_id。",
    SHELL_CONTEXT_DESCRIPTION,
    "只适用于 dev server、watcher、REPL、持续日志或后续确实需要 stdin/轮询输出的进程。不要用它执行普通短命令、一次性脚本或普通文件写入；这些任务使用 run_shell。",
    "需要 shell 语法时传 cmd；直接执行进程时传 executable 加 args。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "exec_command",
      description: [
        "仅启动持续终端进程；仍在运行时返回 session_id，后续才可用 write_stdin 写入或轮询。普通命令和文件操作使用 run_shell。",
        SHELL_CONTEXT_DESCRIPTION
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: `通过 ${SHELL_CONTEXT.shellCommand} 执行的持续 shell 命令。使用 ${SHELL_CONTEXT.syntaxLabel} 语法；使用 executable 加 args 时省略。`
          },
          mode: {
            type: "string",
            enum: ["shell", "process"],
            description: `执行模式。shell 通过 ${SHELL_CONTEXT.shellCommand} 执行 cmd；process 使用 executable 加 args。`
          },
          executable: {
            type: "string",
            description: "mode=process 的可执行程序，例如 node、python、npm 或 npx。"
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "mode=process 的参数数组。"
          },
          workdir: {
            type: "string",
            description: "相对 workspace 的工作目录，默认 workspace 根目录。"
          },
          yield_time_ms: {
            type: "integer",
            minimum: 0,
            description: "返回前等待初始输出的时长，单位毫秒。"
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "后台终端会话的最长存活时间，单位毫秒。"
          },
          maxOutputBytes: {
            type: "integer",
            minimum: 1,
            description: "此终端会话可缓存的最大输出字节数。"
          }
        }
      }
    }
  },
  permissions: ["process.exec", "terminal.session"],
  timeoutMs: 5_000,
  cancelable: true
};

export const WRITE_STDIN_TOOL = {
  name: "write_stdin",
  description: [
    "不是文件写入工具。只能向仍在运行的 exec_command 终端会话写 stdin，或传空 chars 轮询增量输出。",
    "只能使用 exec_command 返回的仍在运行的 session_id；没有 session_id 或会话已结束时绝不能调用本工具。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "write_stdin",
      description: "仅操作已有且仍在运行的持久终端会话；不是文件写入工具。",
      parameters: {
        type: "object",
        required: ["session_id"],
        properties: {
          session_id: {
            type: "string",
            description: "exec_command 返回且仍在运行的终端 session_id。"
          },
          chars: {
            type: "string",
            description: "要写入终端 stdin 的字符；传空字符串只轮询增量输出。"
          },
          yield_time_ms: {
            type: "integer",
            minimum: 0,
            description: "返回前等待更多输出的时长，单位毫秒。"
          }
        }
      }
    }
  },
  permissions: ["terminal.session"],
  timeoutMs: 5_000,
  cancelable: true
};

export const WORKSPACE_SEARCH_TOOL = {
  name: "workspace_search",
  description: "Search text inside the current workspace through the injected rg tool runtime.",
  schema: {
    type: "function",
    function: {
      name: "workspace_search",
      description: "Search text inside the current workspace.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Text or regex pattern to search for."
          },
          path: {
            type: "string",
            description: "Workspace-relative file or directory path. Defaults to the workspace root."
          },
          glob: {
            type: "string",
            description: "Optional rg glob, for example **/*.md."
          },
          maxMatches: {
            type: "integer",
            minimum: 1,
            description: "Maximum matching lines to return."
          }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 30_000,
  cancelable: true
};

export const SKILL_FIND_TOOL = {
  name: "skill_find",
  description: "搜索当前已安装并已注册的 skill。此工具不会访问远端仓库，也不会下载或安装 skill。",
  schema: {
    type: "function",
    function: {
      name: "skill_find",
      description: "只搜索本地已注册 skill，不返回完整 SKILL.md 内容。需要安装新 skill 时，应由产品层或 AgentSkill 的安装管理流程完成。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "按名称、描述、能力或依赖工具匹配本地已注册 skill 的文本关键词。"
          },
          capability: {
            type: "string",
            description: "可选，本地 skill 的精确 capability 标识。"
          },
          requiredTool: {
            type: "string",
            description: "可选，本地 skill 的 requiredTools 或 optionalTools 中必须存在的工具名。"
          },
          includeDisabled: {
            type: "boolean",
            description: "是否包含已禁用 skill，默认 false。"
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "最多返回的本地 skill 数量。"
          }
        }
      }
    }
  },
  permissions: ["skill.index.read"],
  timeoutMs: 5_000,
  cancelable: true
};

export const SKILL_ACTIVATE_TOOL = {
  name: "skill_activate",
  description: "Load a selected skill's SKILL.md content from the injected agent-skill index for CLI-managed context activation.",
  schema: {
    type: "function",
    function: {
      name: "skill_activate",
      description: "Activate a skill by id or name and return a loadedSkill payload for the orchestrator.",
      parameters: {
        type: "object",
        required: ["skill"],
        properties: {
          skill: {
            type: "string",
            description: "Skill id or name from skill_find."
          }
        }
      }
    }
  },
  permissions: ["skill.content.read"],
  timeoutMs: 5_000,
  cancelable: false
};

export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search current public web information through the server-side tool gateway.",
  schema: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web through the server-side gateway. Tavily credentials are configured only on the server.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search query."
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum results override."
          }
        }
      }
    }
  },
  permissions: ["network.web.search"],
  timeoutMs: 20_000,
  cancelable: true
};

export const WEB_FETCH_TOOL = {
  name: "web_fetch",
  description: "Fetch readable content from an exact public http:// or https:// URL through the server-side tool gateway.",
  schema: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch readable content from an exact URL.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "Exact http:// or https:// URL supplied by the user or returned by web_search/web_fetch."
          }
        }
      }
    }
  },
  permissions: ["network.web.fetch"],
  timeoutMs: 20_000,
  cancelable: true
};

export const EMAIL_SEND_TOOL = {
  name: "email_send",
  description: "Send an email through the server-side tool gateway. SMTP credentials are configured only on the server.",
  schema: {
    type: "function",
    function: {
      name: "email_send",
      description: "Send an email. Use this after a scheduled task finishes when email push is enabled.",
      parameters: {
        type: "object",
        required: ["to", "subject"],
        properties: {
          to: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ],
            description: "Recipient email address or addresses."
          },
          cc: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ],
            description: "Optional CC recipient or recipients."
          },
          bcc: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ],
            description: "Optional BCC recipient or recipients."
          },
          subject: {
            type: "string",
            description: "Email subject."
          },
          text: {
            type: "string",
            description: "Plain text email body. Provide text or html."
          },
          html: {
            type: "string",
            description: "HTML email body. Provide text or html."
          },
          attachments: {
            type: "array",
            description: "Optional workspace-local file attachments.",
            items: {
              type: "object",
              required: ["path"],
              properties: {
                path: {
                  type: "string",
                  description: "Workspace-relative attachment file path."
                },
                filename: {
                  type: "string",
                  description: "Optional attachment display filename."
                },
                contentType: {
                  type: "string",
                  description: "Optional attachment MIME type."
                }
              }
            }
          }
        }
      }
    }
  },
  permissions: ["network.email.send", "workspace.read"],
  timeoutMs: 30_000,
  cancelable: true
};
