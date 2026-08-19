/** Late-bound UI hooks so auth/drive/ai never import the full UI module. */
export const hub = {
  render() {},
  updateSyncPill() {},
  updateUserChip() {},
  showLogin() {},
  hideLogin() {},
  renderLogin() {},
  setProcessing() {},
  clearProcessing() {},
};
