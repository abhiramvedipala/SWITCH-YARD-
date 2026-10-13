import { lazy, Suspense } from 'react';

const Md = lazy(() => import('./Md.js'));
const Terminal = lazy(() => import('./TerminalView.js').then((m) => ({ default: m.TerminalView })));

/** Markdown rendered on demand; shows the raw text for the instant it takes to load. */
export function LazyMd({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="pre">{children}</div>}>
      <Md>{children}</Md>
    </Suspense>
  );
}

/** xterm (the biggest dependency) loads only when a terminal is actually on screen. */
export function LazyTerminal(props: { nodeId: string; primary?: boolean }) {
  return (
    <Suspense fallback={<div className="terminal-host" />}>
      <Terminal {...props} />
    </Suspense>
  );
}
