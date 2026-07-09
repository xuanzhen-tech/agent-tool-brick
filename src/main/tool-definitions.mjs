/**
 * agent-tool 暴露给模型的工具定义。
 *
 * 本文件包含通过工具 manifest 对外公布的公共 tool schema。运行时实现位于
 * 相邻模块；把 schema 集中在这里，便于审计模型合同，而不需要一路追踪
 * 执行代码。
 */

const SHELL_CONTEXT = createShellContext(process.platform);
const SHELL_CONTEXT_DESCRIPTION = [
  `Current OS: ${SHELL_CONTEXT.osLabel} (${SHELL_CONTEXT.platform}).`,
  `mode='shell' runs ${SHELL_CONTEXT.shellCommand}; write ${SHELL_CONTEXT.syntaxLabel} syntax.`,
  SHELL_CONTEXT.syntaxHint
].join(" ");

function createShellContext(platform) {
  if (platform === "win32") {
    return {
      platform,
      osLabel: "Windows",
      shellCommand: "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command",
      syntaxLabel: "PowerShell",
      syntaxHint: "Use $env:NAME for environment variables, PowerShell pipelines/conditionals, and commands such as Get-ChildItem or Select-String when relying on shell built-ins."
    };
  }
  return {
    platform,
    osLabel: platform === "darwin" ? "macOS" : "Linux/Unix",
    shellCommand: "/bin/bash -lc",
    syntaxLabel: "bash/POSIX shell",
    syntaxHint: "Use $NAME for environment variables, POSIX shell pipelines/conditionals, and standard Unix command syntax when relying on shell built-ins."
  };
}

export const RUN_SHELL_TOOL = {
  name: "run_shell",
  description: [
    "Execute a focused terminal command in the current workspace with timeout, cancel, and output-size limits.",
    SHELL_CONTEXT_DESCRIPTION,
    "Prefer mode='process' for Python, Node, git, npm, npx, and scripts because executable, args, and stdin are passed without shell quoting.",
    `Use mode='shell' only for ${SHELL_CONTEXT.syntaxLabel}-specific syntax such as pipelines, variables, redirection, and conditional execution.`,
    "Do not perform destructive file operations unless the user explicitly requested them and the target path has been verified."
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "run_shell",
      description: [
        "Execute a focused terminal command in the current workspace with timeout, cancel, and output limits.",
        SHELL_CONTEXT_DESCRIPTION
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["process", "shell"],
            description: `Execution mode. Use process for argv/stdin, shell for ${SHELL_CONTEXT.syntaxLabel} syntax through ${SHELL_CONTEXT.shellCommand}.`
          },
          command: {
            type: "string",
            description: `Shell command for mode=shell. Write ${SHELL_CONTEXT.syntaxLabel} syntax for ${SHELL_CONTEXT.osLabel}.`
          },
          executable: {
            type: "string",
            description: "Executable for mode=process, for example node, python, git, npm, or npx."
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Argument vector for mode=process."
          },
          stdin: {
            type: "string",
            description: "Optional stdin for mode=process."
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Optional timeout override in milliseconds."
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
    "Start a persistent terminal command and yield quickly with a session_id when it keeps running.",
    SHELL_CONTEXT_DESCRIPTION,
    "Use this for dev servers, watchers, REPL-like processes, and commands that may need later stdin or output polling.",
    "Provide cmd for shell syntax, or executable plus args for direct process execution."
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "exec_command",
      description: [
        "Start a persistent terminal command and return a session_id if it is still running.",
        SHELL_CONTEXT_DESCRIPTION
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: `Shell command to run with ${SHELL_CONTEXT.shellCommand}. Write ${SHELL_CONTEXT.syntaxLabel} syntax. Omit when using executable plus args.`
          },
          mode: {
            type: "string",
            enum: ["shell", "process"],
            description: `Execution mode. shell uses cmd through ${SHELL_CONTEXT.shellCommand}; process uses executable plus args.`
          },
          executable: {
            type: "string",
            description: "Executable for mode=process, for example node, python, npm, or npx."
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Argument vector for mode=process."
          },
          workdir: {
            type: "string",
            description: "Workspace-relative working directory. Defaults to workspace root."
          },
          yield_time_ms: {
            type: "integer",
            minimum: 0,
            description: "How long to wait for initial output before returning."
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Maximum lifetime for the background terminal session."
          },
          maxOutputBytes: {
            type: "integer",
            minimum: 1,
            description: "Maximum buffered output bytes for this terminal session."
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
    "Write stdin to a terminal session created by exec_command, or pass empty chars to poll incremental output.",
    "Use the session_id returned by exec_command."
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "write_stdin",
      description: "Write to or poll an existing persistent terminal session.",
      parameters: {
        type: "object",
        required: ["session_id"],
        properties: {
          session_id: {
            type: "string",
            description: "Terminal session id returned by exec_command."
          },
          chars: {
            type: "string",
            description: "Characters to write to stdin. Use an empty string to poll output."
          },
          yield_time_ms: {
            type: "integer",
            minimum: 0,
            description: "How long to wait for more output before returning."
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
