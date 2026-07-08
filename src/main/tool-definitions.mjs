/**
 * agent-tool 暴露给模型的工具定义。
 *
 * 本文件包含通过工具 manifest 对外公布的公共 tool schema。运行时实现位于
 * 相邻模块；把 schema 集中在这里，便于审计模型合同，而不需要一路追踪
 * 执行代码。
 */

export const RUN_SHELL_TOOL = {
  name: "run_shell",
  description: [
    "Execute a focused terminal command in the current workspace with timeout, cancel, and output-size limits.",
    "Prefer mode='process' for Python, Node, git, npm, npx, and scripts because executable, args, and stdin are passed without shell quoting.",
    "Use mode='shell' only for shell-specific syntax such as PowerShell pipelines, variables, redirection, and conditional execution.",
    "Do not perform destructive file operations unless the user explicitly requested them and the target path has been verified."
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "run_shell",
      description: "Execute a focused terminal command in the current workspace with timeout, cancel, and output limits.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["process", "shell"],
            description: "Execution mode. Use process for argv/stdin, shell for PowerShell or shell syntax."
          },
          command: {
            type: "string",
            description: "Shell command for mode=shell."
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
    "Use this for dev servers, watchers, REPL-like processes, and commands that may need later stdin or output polling.",
    "Provide cmd for shell syntax, or executable plus args for direct process execution."
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "exec_command",
      description: "Start a persistent terminal command and return a session_id if it is still running.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "Shell command to run. Omit when using executable plus args."
          },
          mode: {
            type: "string",
            enum: ["shell", "process"],
            description: "Execution mode. shell uses cmd; process uses executable plus args."
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
  description: "Search current public web information through the configured Tavily or generic web gateway provider.",
  schema: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web through the configured provider.",
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
  description: "Fetch readable content from an exact public http:// or https:// URL through the configured web provider.",
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
