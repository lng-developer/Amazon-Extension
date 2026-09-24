export function shouldReconnectSocket({ autoConnect, connected }) {
  return autoConnect !== false && connected !== true;
}
