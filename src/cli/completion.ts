/**
 * Shell completion script generators for silvan CLI
 */

const COMMANDS = [
  'init',
  'quickstart',
  'tree',
  'run',
  'agent',
  'task',
  'pr',
  'ci',
  'config',
  'queue',
  'review',
  'learning',
  'convo',
  'ui',
  'doctor',
  'completion',
];

const TREE_SUBCOMMANDS = [
  'list',
  'add',
  'remove',
  'clean',
  'prune',
  'lock',
  'unlock',
  'rebase',
];
const RUN_SUBCOMMANDS = [
  'list',
  'inspect',
  'status',
  'explain',
  'resume',
  'override',
  'abort',
];
const AGENT_SUBCOMMANDS = ['plan', 'clarify', 'run', 'resume'];
const PR_SUBCOMMANDS = ['open', 'sync'];
const CONFIG_SUBCOMMANDS = ['show', 'validate'];
const CONVO_SUBCOMMANDS = ['show', 'export'];

export function generateBashCompletion(): string {
  return `# silvan bash completion
# Add to ~/.bashrc: eval "$(silvan completion bash)"

_silvan_completions() {
    local cur prev commands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    commands="${COMMANDS.join(' ')}"

    case "\${prev}" in
        silvan)
            COMPREPLY=( $(compgen -W "\${commands} t wt r a" -- "\${cur}") )
            return 0
            ;;
        tree|t|wt)
            COMPREPLY=( $(compgen -W "${TREE_SUBCOMMANDS.join(' ')}" -- "\${cur}") )
            return 0
            ;;
        run|r)
            COMPREPLY=( $(compgen -W "${RUN_SUBCOMMANDS.join(' ')}" -- "\${cur}") )
            return 0
            ;;
        agent|a)
            COMPREPLY=( $(compgen -W "${AGENT_SUBCOMMANDS.join(' ')}" -- "\${cur}") )
            return 0
            ;;
        pr)
            COMPREPLY=( $(compgen -W "${PR_SUBCOMMANDS.join(' ')}" -- "\${cur}") )
            return 0
            ;;
        config)
            COMPREPLY=( $(compgen -W "${CONFIG_SUBCOMMANDS.join(' ')}" -- "\${cur}") )
            return 0
            ;;
        convo)
            COMPREPLY=( $(compgen -W "${CONVO_SUBCOMMANDS.join(' ')}" -- "\${cur}") )
            return 0
            ;;
        ci)
            COMPREPLY=( $(compgen -W "wait" -- "\${cur}") )
            return 0
            ;;
        task)
            COMPREPLY=( $(compgen -W "start" -- "\${cur}") )
            return 0
            ;;
        queue)
            COMPREPLY=( $(compgen -W "run" -- "\${cur}") )
            return 0
            ;;
        review)
            COMPREPLY=( $(compgen -W "unresolved" -- "\${cur}") )
            return 0
            ;;
        learning)
            COMPREPLY=( $(compgen -W "show" -- "\${cur}") )
            return 0
            ;;
        completion)
            COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
            return 0
            ;;
    esac
}

complete -F _silvan_completions silvan
`;
}

export function generateZshCompletion(): string {
  return `#compdef silvan
# silvan zsh completion
# Add to ~/.zshrc: eval "$(silvan completion zsh)"

_silvan() {
    local -a commands
    commands=(
        'init:Initialize silvan.config.ts'
        'quickstart:Guided setup and sample task'
        'tree:Manage git worktrees (alias: t, wt)'
        'run:Manage agent runs (alias: r)'
        'agent:Low-level agent commands (alias: a)'
        'task:Start tasks from issues'
        'pr:Pull request automation'
        'ci:CI/GitHub integration'
        'config:Show/validate configuration'
        'queue:Process queued requests'
        'review:Review management'
        'learning:Learning artifacts'
        'convo:Conversation context'
        'ui:Launch interactive dashboard'
        'doctor:Check environment'
        'completion:Generate shell completions'
    )

    local -a tree_commands
    tree_commands=(
        'list:List all worktrees'
        'add:Create a new worktree'
        'remove:Remove a worktree'
        'clean:Remove merged worktrees'
        'prune:Prune stale data'
        'lock:Lock a worktree'
        'unlock:Unlock a worktree'
        'rebase:Rebase onto base branch'
    )

    local -a run_commands
    run_commands=(
        'list:List recorded runs'
        'inspect:Inspect a run snapshot'
        'status:Show convergence status'
        'explain:Explain blocking state'
        'resume:Resume a run'
        'override:Override a gate'
        'abort:Abort a run'
    )

    local -a agent_commands
    agent_commands=(
        'plan:Generate plan'
        'clarify:Answer plan questions'
        'run:Execute implementation'
        'resume:Resume agent'
    )

    _arguments -C \\
        '1: :->command' \\
        '2: :->subcommand' \\
        '*::arg:->args'

    case "$state" in
        command)
            _describe -t commands 'silvan command' commands
            ;;
        subcommand)
            case "$words[1]" in
                tree|t|wt)
                    _describe -t tree_commands 'tree command' tree_commands
                    ;;
                run|r)
                    _describe -t run_commands 'run command' run_commands
                    ;;
                agent|a)
                    _describe -t agent_commands 'agent command' agent_commands
                    ;;
                pr)
                    _describe -t commands 'pr command' '(open sync)'
                    ;;
                config)
                    _describe -t commands 'config command' '(show validate)'
                    ;;
                convo)
                    _describe -t commands 'convo command' '(show export)'
                    ;;
                completion)
                    _describe -t commands 'shell' '(bash zsh fish)'
                    ;;
            esac
            ;;
    esac
}

_silvan "$@"
`;
}

export function generateFishCompletion(): string {
  return `# silvan fish completion
# Add to ~/.config/fish/completions/silvan.fish

# Disable file completion by default
complete -c silvan -f

# Main commands
complete -c silvan -n "__fish_use_subcommand" -a "init" -d "Initialize silvan.config.ts"
complete -c silvan -n "__fish_use_subcommand" -a "quickstart" -d "Guided setup and sample task"
complete -c silvan -n "__fish_use_subcommand" -a "tree t wt" -d "Manage git worktrees"
complete -c silvan -n "__fish_use_subcommand" -a "run r" -d "Manage agent runs"
complete -c silvan -n "__fish_use_subcommand" -a "agent a" -d "Low-level agent commands"
complete -c silvan -n "__fish_use_subcommand" -a "task" -d "Start tasks from issues"
complete -c silvan -n "__fish_use_subcommand" -a "pr" -d "Pull request automation"
complete -c silvan -n "__fish_use_subcommand" -a "ci" -d "CI/GitHub integration"
complete -c silvan -n "__fish_use_subcommand" -a "config" -d "Show/validate configuration"
complete -c silvan -n "__fish_use_subcommand" -a "queue" -d "Process queued requests"
complete -c silvan -n "__fish_use_subcommand" -a "review" -d "Review management"
complete -c silvan -n "__fish_use_subcommand" -a "learning" -d "Learning artifacts"
complete -c silvan -n "__fish_use_subcommand" -a "convo" -d "Conversation context"
complete -c silvan -n "__fish_use_subcommand" -a "ui" -d "Launch interactive dashboard"
complete -c silvan -n "__fish_use_subcommand" -a "doctor" -d "Check environment"
complete -c silvan -n "__fish_use_subcommand" -a "completion" -d "Generate shell completions"

# tree subcommands
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "list" -d "List all worktrees"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "add" -d "Create a new worktree"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "remove" -d "Remove a worktree"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "clean" -d "Remove merged worktrees"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "prune" -d "Prune stale data"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "lock" -d "Lock a worktree"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "unlock" -d "Unlock a worktree"
complete -c silvan -n "__fish_seen_subcommand_from tree t wt" -a "rebase" -d "Rebase onto base branch"

# run subcommands
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "list" -d "List recorded runs"
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "inspect" -d "Inspect a run snapshot"
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "status" -d "Show convergence status"
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "explain" -d "Explain blocking state"
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "resume" -d "Resume a run"
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "override" -d "Override a gate"
complete -c silvan -n "__fish_seen_subcommand_from run r" -a "abort" -d "Abort a run"

# agent subcommands
complete -c silvan -n "__fish_seen_subcommand_from agent a" -a "plan" -d "Generate plan"
complete -c silvan -n "__fish_seen_subcommand_from agent a" -a "clarify" -d "Answer plan questions"
complete -c silvan -n "__fish_seen_subcommand_from agent a" -a "run" -d "Execute implementation"
complete -c silvan -n "__fish_seen_subcommand_from agent a" -a "resume" -d "Resume agent"

# pr subcommands
complete -c silvan -n "__fish_seen_subcommand_from pr" -a "open" -d "Open/update PR"
complete -c silvan -n "__fish_seen_subcommand_from pr" -a "sync" -d "Sync PR metadata"

# config subcommands
complete -c silvan -n "__fish_seen_subcommand_from config" -a "show" -d "Display configuration"
complete -c silvan -n "__fish_seen_subcommand_from config" -a "validate" -d "Validate configuration"

# convo subcommands
complete -c silvan -n "__fish_seen_subcommand_from convo" -a "show" -d "Show conversation"
complete -c silvan -n "__fish_seen_subcommand_from convo" -a "export" -d "Export conversation"

# completion subcommands
complete -c silvan -n "__fish_seen_subcommand_from completion" -a "bash" -d "Bash completion"
complete -c silvan -n "__fish_seen_subcommand_from completion" -a "zsh" -d "Zsh completion"
complete -c silvan -n "__fish_seen_subcommand_from completion" -a "fish" -d "Fish completion"

# ci subcommands
complete -c silvan -n "__fish_seen_subcommand_from ci" -a "wait" -d "Wait for CI"

# task subcommands
complete -c silvan -n "__fish_seen_subcommand_from task" -a "start" -d "Start a task"

# queue subcommands
complete -c silvan -n "__fish_seen_subcommand_from queue" -a "run" -d "Process queue"

# review subcommands
complete -c silvan -n "__fish_seen_subcommand_from review" -a "unresolved" -d "Fetch unresolved comments"

# learning subcommands
complete -c silvan -n "__fish_seen_subcommand_from learning" -a "show" -d "Show learning notes"
`;
}
