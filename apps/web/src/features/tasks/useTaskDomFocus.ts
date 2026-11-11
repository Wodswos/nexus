import { useEffect, useRef, type RefObject } from 'react';
import { useLocation, useSearchParams } from 'react-router';

/** Resolve after the view renders, once per navigation; edits never recenter the canvas. */
export function useTaskDomFocus(container: RefObject<HTMLElement>, attribute: string, revision: unknown, onFocus?: (id: string) => void) {
  const [params] = useSearchParams();
  const location = useLocation();
  const id = params.get('focusTask');
  const handled = useRef('');
  const callback = useRef(onFocus); callback.current = onFocus;
  useEffect(() => {
    const request = `${location.key}:${id}`;
    if (!id || handled.current === request) return;
    const element = container.current?.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`);
    if (!element) return;
    handled.current = request;
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    callback.current?.(id);
  }, [id, location.key, container, attribute, revision]);
}
