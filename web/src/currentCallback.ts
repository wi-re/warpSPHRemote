/** A stable callback owns only the latest implementation, not its render history.
 * Keep this factory outside React render scopes: control callbacks can otherwise
 * retain a previous parent's snapshot through the child's shared closure scope.
 */
export function currentCallback<F extends (...args: any[]) => any>(
  callback: F,
) {
  const slot = {
    current: callback,
    call: (...args: Parameters<F>): ReturnType<F> => slot.current(...args),
  };
  return slot;
}
