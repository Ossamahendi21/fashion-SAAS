type ComposerKey = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  keyCode?: number;
};

export function shouldSubmitComposer(key: ComposerKey, touchKeyboard: boolean): boolean {
  if (key.key !== "Enter" || key.shiftKey || key.isComposing || key.keyCode === 229) return false;
  return !touchKeyboard || key.metaKey || key.ctrlKey;
}
