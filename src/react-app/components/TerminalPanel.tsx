import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RefreshCcw, TerminalSquare, Wifi, WifiOff } from 'lucide-react';
import { wsUrl } from '../api';

export function TerminalPanel({ serverId, active }: { serverId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [connectionKey, setConnectionKey] = useState(0);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle');

  useEffect(() => {
    if (!active || !hostRef.current) return;
    setStatus('connecting');
    hostRef.current.innerHTML = '';
    const cols = Math.max(80, Math.min(180, Math.floor(hostRef.current.clientWidth / 8.3)));
    const rows = 34;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      cols,
      rows,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#101318',
        foreground: '#eff3f7',
        cursor: '#7dd3fc',
        selectionBackground: '#2f4052'
      }
    });
    terminal.open(hostRef.current);
    terminal.writeln('Connecting to sandbox terminal...');

    const encoder = new TextEncoder();
    const socket = new WebSocket(wsUrl(`/api/servers/${serverId}/terminal?cols=${cols}&rows=${rows}`));
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => setStatus('connecting');
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
        return;
      }

      if (typeof event.data !== 'string') return;

      try {
        const message = JSON.parse(event.data) as { type?: string; message?: string; code?: number; signal?: string };
        if (message.type === 'ready') {
          setStatus('connected');
          terminal.focus();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          }
        } else if (message.type === 'error') {
          setStatus('error');
          terminal.writeln(`\r\nTerminal error: ${message.message ?? 'unknown error'}`);
        } else if (message.type === 'exit') {
          setStatus('closed');
          terminal.writeln(`\r\nTerminal exited${message.code === undefined ? '' : ` with code ${message.code}`}.`);
        }
      } catch {
        // The Sandbox terminal protocol reserves text frames for JSON control messages.
      }
    };
    socket.onerror = () => {
      setStatus('error');
      terminal.writeln('\r\nTerminal connection failed.');
    };
    socket.onclose = () => {
      setStatus((current) => (current === 'error' ? 'error' : 'closed'));
      terminal.writeln('\r\nTerminal disconnected.');
    };
    const dispose = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const resizeDispose = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    return () => {
      dispose.dispose();
      resizeDispose.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [active, serverId, connectionKey]);

  return (
    <section className="terminalPanel">
      <div className="terminalBar">
        <span className={`connectionBadge ${status}`}>
          {status === 'connected' ? <Wifi size={15} /> : <WifiOff size={15} />}
          {status}
        </span>
        <button className="iconTextButton" onClick={() => setConnectionKey((value) => value + 1)}>
          <RefreshCcw size={16} /> Reconnect
        </button>
        <span>
          <TerminalSquare size={15} /> /workspace/server
        </span>
      </div>
      <div className="terminalHost" ref={hostRef} />
    </section>
  );
}
