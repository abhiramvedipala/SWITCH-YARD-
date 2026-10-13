import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { socket } from '../lib/ws.js';
import { useStore } from '../store.js';

const THEME = {
  background: '#0d1016',
  foreground: '#d7dce4',
  cursor: '#22d3ee',
  selectionBackground: '#2a3a4a',
  black: '#1b1f27',
  brightBlack: '#5c6370',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d7dce4',
};

/** One xterm bound to a core-owned PTY. `primary` decides which view drives the PTY size when two are mounted. */
export function TerminalView({ nodeId, primary = true }: { nodeId: string; primary?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const readOnly = useStore((s) => s.readOnly);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: THEME,
      scrollback: 10_000,
      cursorBlink: true,
      disableStdin: readOnly,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let lastSize = '';
    const doFit = () => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const size = `${term.cols}x${term.rows}`;
      if (primary && size !== lastSize) {
        lastSize = size;
        socket.send({ t: 'pty.resize', id: nodeId, cols: term.cols, rows: term.rows });
      }
    };
    const off = socket.on((e) => {
      if (e.t === 'pty.replay' && e.id === nodeId) {
        term.reset();
        term.write(e.data);
      } else if (e.t === 'pty.data' && e.id === nodeId) {
        term.write(e.data);
      }
    });
    requestAnimationFrame(() => {
      doFit();
      socket.attach(nodeId, term.cols, term.rows);
    });
    const input = term.onData((data) => socket.send({ t: 'pty.input', id: nodeId, data }));
    const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
    ro.observe(el);
    if (!primary) setTimeout(() => term.focus(), 50);
    return () => {
      off();
      ro.disconnect();
      input.dispose();
      socket.detach(nodeId);
      term.dispose();
    };
  }, [nodeId, primary, readOnly]);

  return <div ref={ref} className="terminal-host nodrag nowheel nopan" />;
}
