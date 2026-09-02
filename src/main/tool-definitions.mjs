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

export const TOOL_RESULT_READ_TOOL = {
  name: "tool_result_read",
  description: "读取此前因超长而被外置保存的完整工具结果。只能在产生结果的同一 thread 中使用；应先查看结构，再按 JSON Pointer 和分页读取必要字段，禁止尝试一次加载全部数据。",
  schema: {
    type: "function",
    function: {
      name: "tool_result_read",
      description: "按结构、JSON Pointer 或分页读取超长工具结果。省略 path 时只返回字段索引；数组按 offset/limit 分页，文本按 offset/maxChars 分页。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          resultId: {
            type: "string",
            description: "超长工具结果摘要返回的 resultId。"
          },
          path: {
            type: "string",
            description: "可选 JSON Pointer，例如 /data/price；省略时只查看结构。"
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "数组元素或文本字符的起始偏移，默认 0。"
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "数组单页元素数量，默认 20，最大 100。"
          },
          maxChars: {
            type: "integer",
            minimum: 1,
            maximum: 12000,
            description: "文本单页最大字符数，默认 8000，最大 12000。"
          }
        },
        required: ["resultId"]
      }
    }
  },
  permissions: ["tool-result.read"],
  timeoutMs: 20_000,
  cancelable: true,
  defaultVisible: true
};

export const TOOL_RESULT_SEARCH_TOOL = {
  name: "tool_result_search",
  description: "在此前外置保存的超长工具结果中搜索关键词，只返回有限命中和路径。它用于定位必要数据，不会返回完整结果。",
  schema: {
    type: "function",
    function: {
      name: "tool_result_search",
      description: "在同一 thread 的超长工具结果中搜索字段名或值，并返回可供 tool_result_read 继续读取的 JSON Pointer。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          resultId: {
            type: "string",
            description: "超长工具结果摘要返回的 resultId。"
          },
          query: {
            type: "string",
            description: "需要定位的字段名、标识符或文本关键词。"
          },
          maxMatches: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "最大命中数量，默认 20，最大 50。"
          }
        },
        required: ["resultId", "query"]
      }
    }
  },
  permissions: ["tool-result.read"],
  timeoutMs: 20_000,
  cancelable: true,
  defaultVisible: true
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

export const SKILL_CREATE_TOOL = {
  name: "skill_create",
  description: "创建或更新一个完整 Skill 包，并通过注入的 AgentSkill 安装到当前产品管理的 Skill 目录。不得直接猜测或写入安装路径。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "skill_create",
      description: "把 SKILL.md、文本 references/scripts 和 workspace 内已有 assets 组装成受控 Skill 包，再交给 AgentSkill 校验、安装和刷新。首次创建使用 conflict=check；只有用户明确同意覆盖同名 Skill 时才使用 replace。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "instructions"],
        properties: {
          name: {
            type: "string",
            description: "Skill 名称。使用小写字母、数字和连字符，最长 64 个字符，例如 marketplace-review-analysis。"
          },
          description: {
            type: "string",
            description: "触发说明：同时写清这个 Skill 做什么，以及用户在什么任务或表达下应该使用它。"
          },
          instructions: {
            type: "string",
            description: "SKILL.md 正文。只写 Agent 执行任务所需的流程、边界和资源导航，不写 README、安装指南或变更记录。"
          },
          version: {
            type: "string",
            description: "可选 Skill 版本，格式 x.y.z，默认 0.1.0。"
          },
          capabilities: {
            type: "array",
            items: { type: "string" },
            description: "可选能力标识。"
          },
          requiredTools: {
            type: "array",
            items: { type: "string" },
            description: "执行该 Skill 必须可见的工具名称。"
          },
          optionalTools: {
            type: "array",
            items: { type: "string" },
            description: "可选增强工具名称。"
          },
          files: {
            type: "array",
            maxItems: 100,
            description: "可选资源文件。path 只能位于 references/、scripts/ 或 assets/。文本文件传 content；已有二进制或模板传 workspace 相对 sourcePath，二者只能选一个。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path"],
              properties: {
                path: {
                  type: "string",
                  description: "Skill 包内相对路径，例如 references/schema.md、scripts/check.py 或 assets/template.xlsx。"
                },
                content: {
                  type: "string",
                  description: "UTF-8 文本内容，适合 reference 或 script。"
                },
                sourcePath: {
                  type: "string",
                  description: "当前 workspace 内已有文件的相对路径，适合图片、模板等二进制 asset。"
                }
              }
            }
          },
          conflict: {
            type: "string",
            enum: ["check", "replace"],
            description: "同名冲突策略，默认 check。replace 会替换既有 Skill，只能在用户明确授权更新或覆盖时使用。"
          }
        }
      }
    }
  },
  permissions: ["skill.install", "workspace.read", "filesystem.write"],
  timeoutMs: 30_000,
  cancelable: true
};

export const SKILL_REMOVE_TOOL = {
  name: "skill_remove",
  description: "删除当前 AgentSkill 索引中已登记的受管 Skill。只接受 Skill 名称，不接受路径；必须由用户明确要求并传 confirm=true。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "skill_remove",
      description: "通过注入的 AgentSkill.remove() 删除一个已登记 Skill，并清理安装记录和当前实例选择。不得用它删除未知路径或猜测名称。若产品仍在白名单中选择同名预制 Skill，产品下次启动时可能重新安装。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["skill", "confirm"],
        properties: {
          skill: {
            type: "string",
            description: "要删除的精确 Skill id 或 name，必须来自 skill_find 或当前可用 Skill 摘要。"
          },
          confirm: {
            type: "boolean",
            enum: [true],
            description: "仅当用户明确要求删除该 Skill 时传 true。"
          },
          reason: {
            type: "string",
            description: "可选的单行删除原因，用于结果说明，不参与路径解析。"
          }
        }
      }
    }
  },
  permissions: ["skill.remove", "filesystem.write"],
  timeoutMs: 30_000,
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
  description: "受控读取已激活 skill 的 reference/workflow，或将其 asset/template 复制到固定的 workspace 临时目录。",
  schema: {
    type: "function",
    function: {
      name: "skill_resource",
      description: "只能访问已安装 skill 包中的 resources。action=read_reference 接受 references/... 或 workflows/... 的 UTF-8 文本并返回专门上下文；action=copy_asset 接受 assets/... 或 templates/...，会自动复制到 workspace 的 temp/skill-assets/ 固定路径。不要传目标路径，不要用它读取 scripts 或任意工作区文件。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "skill", "path"],
        properties: {
          action: {
            type: "string",
            enum: ["read_reference", "copy_asset"],
            description: "read_reference 读取 references/... 或 workflows/...；copy_asset 物化 assets/... 或 templates/... 到固定临时目录。"
          },
          skill: {
            type: "string",
            description: "已通过 skill_find 找到并可通过 skill_activate 激活的 skill id 或名称。"
          },
          path: {
            type: "string",
            description: "skill 包内相对路径：read_reference 使用 references/... 或 workflows/...，copy_asset 使用 assets/... 或 templates/...；禁止绝对路径和 ..。"
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
    "把当前 workspace 中的 PNG/JPEG/WebP 图片呈递给用户，并生成图片 artifact。",
    "当前模型是否能原生看图由 AgentCli 和 Gateway 的模型能力决定：支持视觉时，图片只会附在紧随的下一次模型请求中；不支持时，图片只展示给用户。本工具不调用其它模型生成文字描述。",
    "适合呈递截图、图表、PPT 页面或其它图片产物；它不是自动 QA 门禁，也不会修改文件。",
    "path 使用 workspace 相对路径，例如 outputs/slide-01.png；不要用 run_shell 读取图片二进制内容。"
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "image_present",
      description: "呈递 workspace 内图片给用户。返回 image artifact；支持原生视觉的当前模型会在下一次请求中直接收到图片，不支持时不会假装看到了图片。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "workspace 相对图片路径，例如 outputs/screenshot.png；也接受位于 workspace 内部的绝对路径。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 10_000,
  cancelable: true
};

const ECOMMERCE_IMAGE_SIZE_SCHEMA = {
  oneOf: [
    {
      type: "string",
      pattern: "^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$",
      description: "GPT Image 2 的宽高比，格式为 宽:高，例如 1:1、4:5、16:9 或 9:16。具体可选项由 Product 决定。"
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "integer", description: "精确宽度，不使用固定尺寸枚举。" },
        height: { type: "integer", description: "精确高度，不使用固定尺寸枚举。" }
      }
    }
  ],
  description: "GPT Image 2 使用 宽:高 字符串并同时传 resolution；比例选项由 Product 提供。Seedream 5.0 继续使用精确 width/height。"
};

const ECOMMERCE_IMAGE_RESOLUTION_SCHEMA = {
  type: "string",
  enum: ["1K", "2K", "4K"],
  description: "仅 GPT Image 2 使用。与比例 size 独立选择；没有用户偏好时使用 1K。"
};

const ECOMMERCE_IMAGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    format: {
      type: "string",
      enum: ["png", "jpeg", "webp"],
      description: "输出格式，默认 png。Seedream 5.0 只支持 png 或 jpeg。"
    },
    compression: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "仅 GPT Image 2 的 JPEG/WebP 可用。PNG 与 Seedream 5.0 不允许传入。"
    }
  }
};

const ECOMMERCE_IMAGE_REFERENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "role", "preserve"],
  properties: {
    path: {
      type: "string",
      description: "当前 workspace 内 PNG/JPEG/WebP 图片路径。"
    },
    role: {
      type: "string",
      enum: ["product", "logo", "style", "scene", "layout"],
      description: "参考图在本次生成中的语义角色。"
    },
    preserve: {
      type: "string",
      enum: ["strict", "balanced", "loose"],
      description: "参考图特征的保留强度。"
    }
  }
};

export const ECOMMERCE_IMAGE_GENERATE_TOOL = {
  name: "ecommerce_image_generate",
  description: "按多个场景请求并发生成电商图片，并在当前工具调用内管理排队、重试、等待、落盘和验证；模型只会收到最终成功、失败或中断结果。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_generate",
      description: "选择 GPT Image 2 或 Seedream 5.0 一次提交多个场景请求。通过 basePrompt 和共享参考图保持商品与品牌一致，每个 requests 项描述独立场景及候选数量；工具会受控并发并阻塞到整批终态。只有 deliveryReady=true 且返回 artifact 时才代表图片可交付，不需要调用状态、取消或重试工具。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["modelId", "requests"],
        properties: {
          modelId: {
            type: "string",
            enum: ["gpt-image-2", "doubao-seedream-5-0"],
            description: "本批次使用的图片模型。优先遵循用户偏好或已激活 skill 的指引；没有明确偏好时使用 gpt-image-2，不要只为该技术参数追问用户。"
          },
          basePrompt: {
            type: "string",
            description: "所有场景共享的商品身份、品牌视觉和一致性约束；不要在这里混入单个场景专属要求。"
          },
          referenceImages: {
            type: "array",
            maxItems: 5,
            items: ECOMMERCE_IMAGE_REFERENCE_SCHEMA,
            description: "所有场景共享的商品、Logo 或品牌参考图。与每个 request 的追加参考图合并后最多 5 张、合计最多 30MB。"
          },
          requests: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            description: "场景请求数组。所有 count 合计最多生成 9 张图片；不同职责使用不同 request，同一职责的候选使用该 request 的 count。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["prompt", "size"],
              properties: {
                key: {
                  type: "string",
                  description: "可选的场景关联键，例如 white-background 或 lifestyle；批次内必须唯一，省略时按顺序生成 request-1。"
                },
                prompt: {
                  type: "string",
                  description: "该场景独有的完整生成要求；共享的商品和品牌约束放在 basePrompt。"
                },
                count: {
                  type: "integer",
                  minimum: 1,
                  maximum: 9,
                  description: "该场景生成的独立候选数量，默认 1。"
                },
                size: ECOMMERCE_IMAGE_SIZE_SCHEMA,
                resolution: ECOMMERCE_IMAGE_RESOLUTION_SCHEMA,
                quality: {
                  type: "string",
                  enum: ["auto", "low", "medium", "high"],
                  description: "该场景的质量偏好，默认 auto。Seedream 5.0 主要由精确 size 控制输出。"
                },
                additionalReferenceImages: {
                  type: "array",
                  maxItems: 5,
                  items: ECOMMERCE_IMAGE_REFERENCE_SCHEMA,
                  description: "仅该场景使用的场景、风格或构图参考图；与共享参考图合并后最多 5 张、合计最多 30MB。"
                }
              }
            }
          },
          output: ECOMMERCE_IMAGE_OUTPUT_SCHEMA
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.image.generate"],
  timeoutMs: 1_200_000,
  cancelable: true
};

export const ECOMMERCE_IMAGE_EDIT_TOOL = {
  name: "ecommerce_image_edit",
  description: "基于任意已有资产版本生成新版本，并在当前工具调用内管理完整执行状态；不覆盖原图片。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_edit",
      description: "把目标版本、修改意见和可选参考图提交给所选图片模型。允许使用与来源版本不同的模型继续编辑；工具会等待整个编辑批次终结，只有 deliveryReady=true 才可交付，versionId 只在所属 assetId 内递增。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["modelId", "edits"],
        properties: {
          modelId: {
            type: "string",
            enum: ["gpt-image-2", "doubao-seedream-5-0"],
            description: "本批编辑使用的图片模型，可与来源资产版本的模型不同。"
          },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["assetId", "versionId", "prompt", "size"],
              properties: {
                assetId: { type: "string", description: "ecommerce_image_generate/list 返回的资产 ID。" },
                versionId: { type: "string", description: "明确的来源版本，例如 v1；允许基于历史版本编辑。" },
                prompt: { type: "string", description: "只描述本次需要修改的内容以及必须保持的内容。" },
                size: ECOMMERCE_IMAGE_SIZE_SCHEMA,
                resolution: ECOMMERCE_IMAGE_RESOLUTION_SCHEMA,
                quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: "默认 auto。" },
                additionalReferenceImages: {
                  type: "array",
                  maxItems: 5,
                  items: ECOMMERCE_IMAGE_REFERENCE_SCHEMA
                }
              }
            }
          },
          output: ECOMMERCE_IMAGE_OUTPUT_SCHEMA
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.image.generate"],
  timeoutMs: 1_200_000,
  cancelable: true
};

export const ECOMMERCE_VIDEO_GENERATE_TOOL = {
  name: "ecommerce_video_generate",
  description: "提交一张 workspace 商品照片生成 Seedance 商品视频；可靠记录本地任务后立即返回，后台受控执行。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_video_generate",
      description: "根据已激活的商品视频 skill 组织完整提示词，再提交一张商品照片生成视频。用户没有明确要求时使用 6 秒、1080p、adaptive、无音频。返回 queued 只表示任务已受理，不代表视频完成；只有后续状态结果 deliveryReady=true 且返回 video artifact 才能报告生成完成。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["imagePath", "prompt"],
        properties: {
          modelId: {
            type: "string",
            enum: ["doubao-seedance-2-0"],
            description: "首版固定为 doubao-seedance-2-0，省略时使用该默认值。"
          },
          imagePath: {
            type: "string",
            description: "当前 workspace 内一张 PNG、JPEG 或 WebP 商品照片的相对路径。"
          },
          prompt: {
            type: "string",
            maxLength: 20000,
            description: "完整视频导演提示词：主体锁定、镜头、动作、场景、光线、节奏、禁止项和商品真实性约束。"
          },
          aspectRatio: {
            type: "string",
            enum: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"],
            description: "输出画幅，默认 adaptive。"
          },
          duration: {
            type: "integer",
            minimum: 4,
            maximum: 15,
            description: "视频秒数，默认 6。"
          },
          resolution: {
            type: "string",
            enum: ["720p", "1080p"],
            description: "输出分辨率，默认 1080p。"
          },
          generateAudio: {
            type: "boolean",
            description: "是否生成音频，默认 false。商品视频首版通常保持关闭。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.video.generate"],
  timeoutMs: 60_000,
  cancelable: true
};

export const ECOMMERCE_VIDEO_STATUS_TOOL = {
  name: "ecommerce_video_status",
  description: "查询一个商品视频任务的最新状态和已验证产物，可进行最多 30 秒的低频长轮询。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_video_status",
      description: "根据本地 jobId 查询状态。queued/running/interrupted 都不是完成；只有 deliveryReady=true 且存在 video artifact 时才可交付。不要连续高频调用。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: {
          jobId: { type: "string", description: "ecommerce_video_generate 返回的本地任务 ID。" },
          waitMs: { type: "integer", minimum: 0, maximum: 30000, description: "可选长轮询等待，默认 0。" }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 35_000,
  cancelable: true
};

export const ECOMMERCE_VIDEO_CANCEL_TOOL = {
  name: "ecommerce_video_cancel",
  description: "取消排队或运行中的商品视频任务，并尽力把取消传递给 Provider。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_video_cancel",
      description: "仅在用户明确要求停止任务时调用。已提交给 Provider 的任务可能在取消请求到达前产生费用；cancel_uncertain 表示不能确认 Provider 是否停止。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: {
          jobId: { type: "string", description: "要取消的本地任务 ID。" }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.video.generate"],
  timeoutMs: 30_000,
  cancelable: true
};

export const ECOMMERCE_VIDEO_RETRY_TOOL = {
  name: "ecommerce_video_retry",
  description: "恢复可续查的中断任务，或在明确确认后复制失败任务并创建新的计费任务。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_video_retry",
      description: "interrupted 且已有 Provider task 时续查原任务，不重复计费；其它失败或取消任务会新建任务，因此必须由用户明确同意并传 confirm=true。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["jobId", "confirm"],
        properties: {
          jobId: { type: "string", description: "要恢复或重试的本地任务 ID。" },
          confirm: { type: "boolean", enum: [true], description: "确认允许在必要时创建新的计费任务。" }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.video.generate"],
  timeoutMs: 60_000,
  cancelable: true
};

export const ECOMMERCE_VIDEO_LIST_TOOL = {
  name: "ecommerce_video_list",
  description: "查询当前 workspace 中商品视频任务及已验证的 MP4 产物。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_video_list",
      description: "按 jobId 或状态查询商品视频任务。该工具只读取本地持久化状态，不会重新提交计费任务。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: { type: "string", description: "ecommerce_video_generate 返回的任务 ID。" },
          status: {
            type: "string",
            enum: ["submitting", "queued", "running", "interrupted", "completed", "failed", "cancelled"]
          },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "默认 50。" }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 30_000,
  cancelable: false
};

export const ECOMMERCE_IMAGE_BATCH_TOOL = {
  name: "ecommerce_image_batch",
  description: "SDK/HTTP 兼容入口：查询、取消或重试历史电商图片批次；不向模型暴露。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_batch",
      description: "兼容入口。省略 action 时默认查询 status；cancel 保留已完成图片；retry 只复制失败或中断项创建新批次。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["batchId"],
        properties: {
          action: {
            type: "string",
            enum: ["status", "cancel", "retry"],
            description: "兼容动作，默认 status。新调用应改用专用 job 工具。"
          },
          batchId: { type: "string" },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: 30_000,
            description: "仅 status 使用，最多等待 30 秒。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.image.generate"],
  timeoutMs: 35_000,
  cancelable: true
};

export const ECOMMERCE_IMAGE_JOB_STATUS_TOOL = {
  name: "ecommerce_image_job_status",
  description: "SDK/HTTP 诊断入口：查询电商图片任务状态；不向模型暴露。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_job_status",
      description: "根据 operationId 查询图片任务。只有 deliveryReady=true 且存在 artifact 时才能向用户报告图片已完成。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["operationId"],
        properties: {
          operationId: {
            type: "string",
            description: "generate、edit 或 retry 返回的 operationId。"
          },
          waitMs: {
            type: "integer",
            minimum: 0,
            maximum: 30_000,
            description: "最长等待任务状态变化并持续检查到终态的时间，默认 30000。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 35_000,
  cancelable: true
};

export const ECOMMERCE_IMAGE_JOB_CANCEL_TOOL = {
  name: "ecommerce_image_job_cancel",
  description: "SDK/HTTP 诊断入口：取消图片任务并保留已经完成的图片；不向模型暴露。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_job_cancel",
      description: "根据 operationId 取消图片任务。上游是同步生图接口，已经发送的请求仍可能继续生成并计费。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["operationId"],
        properties: {
          operationId: {
            type: "string",
            description: "generate、edit 或 retry 返回的 operationId。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.image.generate"],
  timeoutMs: 10_000,
  cancelable: true
};

export const ECOMMERCE_IMAGE_JOB_RETRY_TOOL = {
  name: "ecommerce_image_job_retry",
  description: "SDK/HTTP 兼容入口：重试历史任务中的 failed/interrupted 项目；不向模型暴露。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_job_retry",
      description: "根据 operationId 重试可恢复的失败项，返回新的 operationId；不会覆盖已经完成的图片。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["operationId"],
        properties: {
          operationId: {
            type: "string",
            description: "需要重试的原 operationId。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.write", "network.image.generate"],
  timeoutMs: 1_200_000,
  cancelable: true
};

export const ECOMMERCE_IMAGE_LIST_TOOL = {
  name: "ecommerce_image_list",
  description: "查询电商图片批次或资产的不可覆盖版本历史。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "ecommerce_image_list",
      description: "按 batchId、assetId 或状态查询。versionId 只在所属 assetId 内有效；不要根据对话轮次推断全局 V1/V2/V3。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          batchId: { type: "string" },
          assetId: { type: "string" },
          status: {
            type: "string",
            enum: ["queued", "running", "partial", "completed", "failed", "cancelled", "interrupted"]
          },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 10_000,
  cancelable: false
};

export const SPREADSHEET_INSPECT_TOOL = {
  name: "spreadsheet_inspect",
  description: "检查 workspace 内 XLSX、XLSM、CSV 或 TSV 的真实结构，生成带来源哈希的 analysisId、稳定 tableId、字段画像和样本。表格计算前必须先使用本工具；存在多个区域或表头歧义时，不得自行猜测。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "spreadsheet_inspect",
      description: "确定性检查表格结构。path 必须位于当前 workspace；返回的 tableId 是后续 spreadsheet_compute 的唯一表范围依据。公式缓存只会标记，不会被信任为权威金额。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "workspace 相对或内部绝对路径，通常来自 uploads/；支持 xlsx、xlsm、csv、tsv。"
          },
          sheets: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            description: "可选工作表白名单。CSV/TSV 的工作表固定名为 data。"
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.temp.write"],
  timeoutMs: 120_000,
  cancelable: true
};

export const SPREADSHEET_COMPUTE_TOOL = {
  name: "spreadsheet_compute",
  description: "基于 spreadsheet_inspect 返回的 analysisId/tableId 做确定性筛选、联接、分组、Decimal 聚合和安全派生指标。正式金额、比率、汇总和图表数据应来自本工具，不能由模型心算。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "spreadsheet_compute",
      description: "执行最多 20 个声明式查询并返回 resultId/dataRef。公式列不能作为权威输入；缺失值默认失败，分母为零返回 not_computable。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["analysisId", "queries"],
        properties: {
          analysisId: { type: "string", description: "spreadsheet_inspect 返回的 analysisId。" },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "tableId"],
              properties: {
                id: { type: "string", description: "本次调用内唯一的查询名称。" },
                tableId: { type: "string", description: "inspect 返回的明确 tableId。" },
                columns: {
                  type: "array",
                  maxItems: 512,
                  items: { type: "string" },
                  description: "选择原始字段的行结果；使用时不能同时提供 groupBy、measures 或 derivedMetrics。"
                },
                filters: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["column", "operator"],
                    properties: {
                      column: { type: "string" },
                      operator: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "is_null", "not_null"] },
                      value: { description: "eq/neq/gt/gte/lt/lte 的比较值。" },
                      values: { type: "array", description: "in/not_in 的比较值数组。", items: {} }
                    }
                  }
                },
                joins: {
                  type: "array",
                  maxItems: 5,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["tableId", "leftColumns", "rightColumns", "cardinality"],
                    properties: {
                      tableId: { type: "string", description: "同一 analysisId 内的右表 tableId。" },
                      type: { type: "string", enum: ["left", "inner"], description: "默认 left。" },
                      leftColumns: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
                      rightColumns: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
                      cardinality: { type: "string", enum: ["one_to_one", "many_to_one", "one_to_many"] },
                      summaryRowPolicy: { type: "string", enum: ["exclude", "include"], description: "右表检测到合计行时必须显式选择。" },
                      prefix: { type: "string", description: "右表非键字段前缀，默认 join1、join2。" }
                    }
                  }
                },
                summaryRowPolicy: { type: "string", enum: ["exclude", "include"], description: "主表检测到合计/总计行时必须显式选择，通常为 exclude。" },
                groupBy: { type: "array", maxItems: 64, items: { type: "string" } },
                measures: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "operation"],
                    properties: {
                      id: { type: "string" },
                      operation: { type: "string", enum: ["sum", "count", "countDistinct", "min", "max", "mean"] },
                      column: { type: "string", description: "count 全行时可省略，其他聚合必须提供。" }
                    }
                  }
                },
                derivedMetrics: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "operation", "left", "right"],
                    properties: {
                      id: { type: "string" },
                      operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
                      left: { description: "聚合字段名或数值常量。" },
                      right: { description: "聚合字段名或数值常量。" },
                      zeroPolicy: { type: "string", enum: ["not_computable", "fail"], description: "默认 not_computable。" },
                      scale: { type: "integer", minimum: 0, maximum: 12 },
                      rounding: { type: "string", enum: ["half_up", "half_even"], description: "默认 half_up。" }
                    }
                  }
                },
                columnParsers: {
                  type: "array",
                  maxItems: 100,
                  description: "字符串数字存在逗号等歧义时显式声明解析规则。",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["column", "type"],
                    properties: {
                      tableId: { type: "string" },
                      column: { type: "string" },
                      type: { type: "string", enum: ["decimal", "integer", "string", "date"] },
                      decimalSeparator: { type: "string", enum: [".", ","] },
                      thousandsSeparator: { type: "string" },
                      currencySymbols: { type: "array", maxItems: 10, items: { type: "string" } }
                    }
                  }
                },
                nullPolicy: { type: "string", enum: ["fail", "exclude"], description: "默认 fail，避免静默跳过缺失金额。" },
                sort: {
                  type: "array",
                  maxItems: 20,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["field"],
                    properties: {
                      field: { type: "string" },
                      direction: { type: "string", enum: ["asc", "desc"] }
                    }
                  }
                },
                limit: { type: "integer", minimum: 1, maximum: 100000, description: "显式形成前 N 行受限结果；省略时若结果超过 10 万行会阻断并要求先筛选或聚合。受限结果不能用于完整质量门。" }
              }
            }
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.temp.write"],
  timeoutMs: 120_000,
  cancelable: true
};

export const SPREADSHEET_VALIDATE_TOOL = {
  name: "spreadsheet_validate",
  description: "对表格字段质量、金额恒等式、预算可行性和 ID/关键词集合关系做确定性质量门校验。必需检查失败时工具返回 failed，Agent 只能报告差异和补数需求，不得继续输出正式策略。",
  defaultVisible: false,
  schema: {
    type: "function",
    function: {
      name: "spreadsheet_validate",
      description: "校验同一 analysisId 下的原始 table 和 compute result。数值表达式只支持常量、结果单元格及 add/subtract/multiply/divide/sum 组合，不执行代码。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["analysisId", "resultIds", "checks"],
        properties: {
          analysisId: { type: "string" },
          resultIds: { type: "array", maxItems: 100, items: { type: "string" }, description: "本次校验允许引用的 resultId 白名单。" },
          checks: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "type"],
              properties: {
                id: { type: "string" },
                type: { type: "string", enum: ["column_quality", "numeric_compare", "set_relation"] },
                required: { type: "boolean", description: "默认 true；false 的失败只形成 warning。" },
                target: {
                  type: "object",
                  additionalProperties: false,
                  properties: { tableId: { type: "string" }, resultId: { type: "string" } },
                  description: "column_quality 的检查对象。"
                },
                minimumRows: { type: "integer", minimum: 0 },
                columns: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name"],
                    properties: {
                      name: { type: "string" },
                      required: { type: "boolean" },
                      notNull: { type: "boolean" },
                      unique: { type: "boolean" },
                      minCoverage: { type: "number", minimum: 0, maximum: 1, description: "非空值最低覆盖率，0-1。" },
                      type: { type: "string", enum: ["string", "integer", "decimal", "number", "date", "boolean"] },
                      forbiddenPattern: { type: "string", description: "该列禁止匹配的受限正则，例如在关键词列拒绝 ASIN 形态。" }
                    }
                  }
                },
                left: { type: "object", description: "数值表达式或集合操作数；可用 value、values、resultId/field/rowIndex、operation/operands。" },
                right: { type: "object", description: "数值表达式或集合操作数；可用 value、values、resultId/field/rowIndex、operation/operands。" },
                operator: { type: "string", enum: ["eq", "lte", "gte"] },
                relation: { type: "string", enum: ["subset", "equal"] },
                absoluteTolerance: { description: "数值相等的绝对容差，默认 0；货币通常使用 0.01。" },
                relativeTolerance: { description: "数值相等的相对容差，默认 0。" }
              }
            }
          }
        }
      }
    }
  },
  permissions: ["workspace.read", "workspace.temp.write"],
  timeoutMs: 120_000,
  cancelable: true
};

function spreadsheetDataRefSchema(description) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "analysisId", "resultId"],
    properties: {
      schemaVersion: { type: "string", enum: ["agent-spreadsheet.data-ref.v1"] },
      analysisId: { type: "string" },
      resultId: { type: "string" }
    },
    description
  };
}

function spreadsheetValueRefSchema(description) {
  const schema = spreadsheetDataRefSchema(description);
  schema.required = [...schema.required, "field"];
  schema.properties = {
    ...schema.properties,
    rowIndex: { type: "integer", minimum: 0, description: "结果行下标，默认 0。" },
    field: { type: "string", description: "要读取的结果字段。" }
  };
  return schema;
}

// 可视化工具默认不进入 new AgentTool() 的旧行为。产品需要在 tools 白名单中
// 明确选择它们，才会让模型看到这些数据处理和文件输出能力。
export const VISUALIZATION_CREATE_CHART_TOOL = {
  name: "visualization_create_chart",
  description: "使用受控 Vega-Lite 声明和内联表格数据或 spreadsheet_compute 的 dataRef 生成图表。会把 JSON、SVG、PNG 写入当前 workspace 的 outputs/visualizations/，并返回可供界面直接渲染的 artifact；不执行任意 HTML 或 JavaScript。",
  schema: {
    type: "function",
    function: {
      name: "visualization_create_chart",
      description: "创建单个数据图表。spec 必须是纯 Vega-Lite 声明式对象；data 与 dataRef 互斥。正式表格分析应优先引用 spreadsheet_compute 的 dataRef，避免重新复制或计算数字。禁止 URL、远端数据、信号、lookup、任意脚本和 HTML。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["spec"],
        properties: {
          title: { type: "string", description: "图表标题。" },
          spec: { type: "object", description: "Vega-Lite v5 声明式图表 spec。可使用受控 transform（如 fold、aggregate、filter、calculate）；不要使用 url、signal、expr 或 lookup。" },
          data: { type: "array", items: { type: "object" }, description: "兼容用内联对象数组。提供时会覆盖 spec.data。" },
          dataRef: spreadsheetDataRefSchema("spreadsheet_compute 返回的 canonical 数据引用；与 data 互斥。")
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
  description: "使用受控 KPI、洞察、图表、表格和文本面板生成结构化 BI 看板。图表、表格和 KPI 可直接引用 spreadsheet_compute 的 canonical 结果，避免不同章节重复计算。",
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
          kpis: {
            type: "array",
            maxItems: 20,
            description: "可选 KPI 数组；value/valueRef、change/changeRef 分别互斥。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label"],
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                valueRef: spreadsheetValueRefSchema("从 spreadsheet_compute 结果读取 KPI 值。"),
                change: { type: "string" },
                changeRef: spreadsheetValueRefSchema("从 spreadsheet_compute 结果读取 KPI 变化值。"),
                tone: { type: "string", enum: ["neutral", "positive", "negative"] }
              }
            }
          },
          insights: { type: "array", description: "可选关键洞察文本数组。", items: { type: "string" } },
          panels: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description: "面板数组。chart 必须提供 spec，并使用 data 或 dataRef；table 使用 rows 或 dataRef；text 使用 content。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                id: { type: "string" },
                kind: { type: "string", enum: ["chart", "table", "text"] },
                title: { type: "string" },
                description: { type: "string" },
                spec: { type: "object", description: "chart 面板的受控 Vega-Lite spec。" },
                data: { type: "array", items: { type: "object" }, description: "chart 的兼容内联数据；与 dataRef 互斥。" },
                dataRef: spreadsheetDataRefSchema("chart/table 面板的 canonical 数据引用。"),
                columns: { type: "array", items: { type: "string" }, description: "table 显示字段；dataRef 模式省略时使用全部结果字段。" },
                rows: { type: "array", items: {}, description: "table 的兼容内联数据；与 dataRef 互斥。" },
                content: { type: "string", description: "text 面板正文。" }
              }
            }
          }
        }
      }
    }
  },
  permissions: ["workspace.outputs.write"],
  timeoutMs: 120_000,
  cancelable: true,
  defaultVisible: false
};
