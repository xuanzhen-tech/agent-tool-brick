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

// workspace 由调用方作为子进程 cwd 传入，而非环境变量。将这条约束写入每个
// 终端工具 schema，避免模型把空的 WORKSPACE 环境变量解析成磁盘根目录路径。
const WORKSPACE_PATH_CONTRACT = [
  "当前 workspace 已作为子进程 cwd 设置，但不是环境变量。",
  "普通工作区文件操作优先使用相对路径，例如 outputs/about.txt；不要假设 $env:WORKSPACE、%WORKSPACE% 或 $WORKSPACE 存在。",
  "不要把 \\outputs 或 C:\\outputs 当作默认输出位置；需要绝对路径时使用调用方提供的 workspace 完整路径。"
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
    WORKSPACE_PATH_CONTRACT,
    "普通文件读写、Python、Node、git、npm、npx 和一次性脚本都优先使用本工具；Python、Node 等优先使用 mode='process'，这样 executable、args 和 stdin 不需要 shell 转义。",
    `只有必须使用 ${SHELL_CONTEXT.syntaxLabel} 的管道、变量、重定向或条件语句时才使用 mode='shell'。`,
    "生成正式交付文件时必须写入 outputs/：在同一命令中创建缺失目录、以 UTF-8 写入、并验证目标文件存在。用户明确指定文件正文时，必须逐字符原样写入，不得擅自添加标点、标题、解释、额外文本或换行；同次命令中要读回并用严格相等比较验证内容。命令失败、超时或未验证成功时，不得宣称任务已完成。",
    "除非用户明确要求且已核验目标路径，否则不要执行破坏性文件操作。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "run_shell",
      description: [
        "默认的一次性终端工具。用于普通文件读写、脚本、Python、Node、git、npm 和短时命令；不用于持续运行的服务或交互式终端。",
        SHELL_CONTEXT_DESCRIPTION,
        WORKSPACE_PATH_CONTRACT
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
            description: `mode=shell 的命令。${SHELL_CONTEXT.osLabel} 上必须使用 ${SHELL_CONTEXT.syntaxLabel} 语法。${WORKSPACE_PATH_CONTRACT} 正式输出需在命令内创建 outputs/、使用 UTF-8，并验证文件存在。用户明确指定正文时必须逐字符原样写入，不得增加标点、标题、解释、额外文本或换行；同次命令中读回并严格比较内容。`
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
    WORKSPACE_PATH_CONTRACT,
    "只适用于 dev server、watcher、REPL、持续日志或后续确实需要 stdin/轮询输出的进程。不要用它执行普通短命令、一次性脚本或普通文件写入；这些任务使用 run_shell。",
    "需要 shell 语法时传 cmd；直接执行进程时传 executable 加 args。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "exec_command",
      description: [
        "仅启动持续终端进程；仍在运行时返回 session_id，后续才可用 write_stdin 写入或轮询。普通命令和文件操作使用 run_shell。",
        SHELL_CONTEXT_DESCRIPTION,
        WORKSPACE_PATH_CONTRACT
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
            description: "相对 workspace 的工作目录，默认 workspace 根目录。workspace 是 cwd 而非环境变量；不要填写 $env:WORKSPACE、%WORKSPACE% 或 $WORKSPACE。"
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
  description: "Search installed and remote skills, or install a selected remote skill through the injected AgentSkill runtime.",
  schema: {
    type: "function",
    function: {
      name: "skill_find",
      description: "Search installed skills and remote providers, then install selected skills when needed. It never returns full SKILL.md content.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search", "install"],
            description: "Use search to find local/remote skills, or install to download a selected candidate."
          },
          query: {
            type: "string",
            description: "Text query matched against installed skills and remote providers."
          },
          source: {
            type: "string",
            enum: ["all", "openai-curated", "skills-sh", "skillhub", "clawhub"],
            description: "Remote source to search or install from. clawhub is accepted as an alias for skillhub."
          },
          capability: {
            type: "string",
            description: "Optional installed-skill capability id to match exactly."
          },
          requiredTool: {
            type: "string",
            description: "Optional installed-skill required or optional tool name to match exactly."
          },
          package: {
            type: "string",
            description: "skills.sh package identifier to install, for example owner/repo@skill."
          },
          slug: {
            type: "string",
            description: "SkillHub slug to install."
          },
          name: {
            type: "string",
            description: "OpenAI curated skill name to install, or destination name for a GitHub skill URL."
          },
          url: {
            type: "string",
            description: "GitHub skill directory URL to install."
          },
          includeDisabled: {
            type: "boolean",
            description: "Include disabled skills in the result. Defaults to false."
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of skills to return."
          }
        }
      }
    }
  },
  permissions: ["skill.index.read", "network.fetch", "filesystem.write"],
  timeoutMs: 300_000,
  cancelable: true
};

export const SKILL_ACTIVATE_TOOL = {
  name: "skill_activate",
  description: "激活已安装 skill 的 SKILL.md，并返回资源清单；不会读取 references 或复制 assets。",
  schema: {
    type: "function",
    function: {
      name: "skill_activate",
      description: "按 id 或名称激活 skill。它只返回 SKILL.md 的 loadedSkill 上下文和 resources 清单；需要读取 references 或使用 assets 时，必须继续调用 skill_resource。",
      parameters: {
        type: "object",
        additionalProperties: false,
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

export const SKILL_RESOURCE_TOOL = {
  name: "skill_resource",
  description: "受控读取已激活 skill 的 reference，或将其 asset 复制到固定的 workspace 临时目录。",
  schema: {
    type: "function",
    function: {
      name: "skill_resource",
      description: "只能访问已安装 skill 包中的 resources。action=read_reference 只接受 references/... 的 UTF-8 文本并返回专门上下文；action=copy_asset 只接受 assets/...，会自动复制到 workspace 的 temp/skill-assets/ 固定路径。不要传目标路径，不要用它读取 scripts 或任意工作区文件。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "skill", "path"],
        properties: {
          action: {
            type: "string",
            enum: ["read_reference", "copy_asset"],
            description: "read_reference 读取 references/...；copy_asset 物化 assets/... 到固定临时目录。"
          },
          skill: {
            type: "string",
            description: "已通过 skill_find 找到并可通过 skill_activate 激活的 skill id 或名称。"
          },
          path: {
            type: "string",
            description: "skill 包内相对路径：read_reference 使用 references/...，copy_asset 使用 assets/...；禁止绝对路径和 ..。"
          }
        }
      }
    }
  },
  permissions: ["skill.resource.read", "workspace.temp.write"],
  timeoutMs: 15_000,
  cancelable: true
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

export const IMAGE_PRESENT_TOOL = {
  name: "image_present",
  description: [
    "把当前 workspace 中的 PNG/JPEG/WebP 图片呈递给服务端视觉模型观察，并返回可供下一步推理使用的观察结果。",
    "适合渲染截图后检查页面、图表、PPT 页面或其他图片内容；它不是自动 QA 门禁，也不会修改文件。",
    "path 使用 workspace 相对路径，例如 outputs/slide-01.png；不要用 run_shell 读取图片二进制内容。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "image_present",
      description: "呈递 workspace 内图片给视觉模型观察。返回观察文本，并生成 image artifact 供界面展示和后续上下文引用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "workspace 相对图片路径，例如 outputs/screenshot.png；也接受位于 workspace 内部的绝对路径。"
          },
          prompt: {
            type: "string",
            description: "可选观察重点，例如检查文字是否裁切、图表是否可读、页面是否和预期一致。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "network.vision.present"],
  timeoutMs: 60_000,
  cancelable: true
};

// 可视化工具默认不进入 new AgentTool() 的旧行为。产品需要在 tools 白名单中
// 明确选择它们，才会让模型看到这些数据处理和文件输出能力。
export const VISUALIZATION_CREATE_CHART_TOOL = {
  name: "visualization_create_chart",
  description: "使用受控 Vega-Lite 声明和内联表格数据生成图表。会把 JSON、SVG、PNG 写入当前 workspace 的 outputs/visualizations/，并返回可供界面直接渲染的 artifact；不执行任意 HTML 或 JavaScript。",
  schema: {
    type: "function",
    function: {
      name: "visualization_create_chart",
      description: "创建单个数据图表。spec 必须是纯 Vega-Lite 声明式对象，data 必须是对象数组；支持 fold、aggregate、filter、calculate 等受控数据整形，禁止 URL、远端数据、信号、lookup、任意脚本和 HTML。成功后输出固定在 workspace 的 outputs/visualizations/。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["spec"],
        properties: {
          title: { type: "string", description: "图表标题。" },
          spec: { type: "object", description: "Vega-Lite v5 声明式图表 spec。可使用受控 transform（如 fold、aggregate、filter、calculate）；不要使用 url、signal、expr 或 lookup。" },
          data: { type: "array", items: { type: "object" }, description: "可选的内联对象数组。提供时会覆盖 spec.data。" }
        }
      }
    }
  },
  permissions: ["workspace.outputs.write"],
  timeoutMs: 60_000,
  cancelable: true,
  defaultVisible: false
};

export const VISUALIZATION_CREATE_DASHBOARD_TOOL = {
  name: "visualization_create_dashboard",
  description: "使用受控 KPI、洞察、图表、表格和文本面板生成结构化 BI 看板。会输出 dashboard JSON、静态 HTML、图表 SVG/PNG 到 workspace 的 outputs/visualizations/，并返回结构化 artifact。",
  schema: {
    type: "function",
    function: {
      name: "visualization_create_dashboard",
      description: "创建结构化 BI 看板。panels 只支持 chart、table、text；chart 使用受控 Vega-Lite spec。当前不承诺筛选、联动或下钻等交互能力，不能把它们伪装为已实现。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "panels"],
        properties: {
          title: { type: "string", description: "看板标题。" },
          summary: { type: "string", description: "可选的看板摘要。" },
          kpis: { type: "array", description: "可选 KPI 数组，每项包含 label、value、change、tone。", items: { type: "object" } },
          insights: { type: "array", description: "可选关键洞察文本数组。", items: { type: "string" } },
          panels: { type: "array", minItems: 1, description: "面板数组。chart 需要 spec 和可选 data；table 需要 columns、rows；text 需要 content。", items: { type: "object" } }
        }
      }
    }
  },
  permissions: ["workspace.outputs.write"],
  timeoutMs: 120_000,
  cancelable: true,
  defaultVisible: false
};
