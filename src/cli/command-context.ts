export interface RecoveryCommandContext {
  /** One already shell-safe argument following `--root`. */
  readonly stateRootArgument: string;
  /** Optional operator instruction shown before copyable commands. */
  readonly instruction?: string;
}

export const TELEGRAM_RECOVERY_COMMAND_CONTEXT: RecoveryCommandContext = {
  stateRootArgument: `"\${OPENMURMUR_STATE_ROOT:?set exact daemon state root locally}"`,
  instruction:
    'Локально задай OPENMURMUR_STATE_ROOT равным точному state root этого демона; путь не отправляется в Telegram.',
};

export function shellQuotedStateRoot(root: string): string | null {
  if (root.length > 512 || !/^[\x20-\x7e]+$/.test(root)) return null;
  return `'${root.replaceAll("'", `'"'"'`)}'`;
}

export function recoveryCommandContextForRoot(root: string): RecoveryCommandContext {
  const stateRootArgument = shellQuotedStateRoot(root);
  return stateRootArgument === null ? TELEGRAM_RECOVERY_COMMAND_CONTEXT : { stateRootArgument };
}

export function openMurmurRecoveryCommand(context: RecoveryCommandContext, args: string): string {
  return `pnpm openmurmur --root ${context.stateRootArgument} ${args}`;
}
