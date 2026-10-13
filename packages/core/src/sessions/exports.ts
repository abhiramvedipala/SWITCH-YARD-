/**
 * Minimal parsers for chat exports (Claude.ai and ChatGPT `conversations.json`).
 * Written in-house instead of pulling in @october-dev/moirai to keep the dependency list short;
 * both formats are plain JSON and only need title + ordered turns here.
 */

export interface ParsedConversation {
  source: 'claude.ai' | 'chatgpt' | 'unknown';
  title: string;
  createdAt?: string;
  turns: { role: 'user' | 'assistant' | 'system'; text: string }[];
}

function claudeAiText(m: Record<string, unknown>): string {
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  const content = m.content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === 'text') return String(block.text ?? '');
        if (block.type === 'tool_use') return `[tool: ${String(block.name ?? '')}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseClaudeAi(c: Record<string, unknown>): ParsedConversation {
  const msgs = (c.chat_messages as Array<Record<string, unknown>>) ?? [];
  return {
    source: 'claude.ai',
    title: String(c.name || 'Untitled Claude chat'),
    createdAt: c.created_at as string | undefined,
    turns: msgs
      .map((m) => ({
        role: (m.sender === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
        text: claudeAiText(m),
      }))
      .filter((t) => t.text.trim()),
  };
}

function parseChatGpt(c: Record<string, unknown>): ParsedConversation {
  const mapping = (c.mapping as Record<string, Record<string, unknown>>) ?? {};
  // Walk from current_node back to the root, which gives the conversation as the user last saw it.
  const chain: Record<string, unknown>[] = [];
  let cur = c.current_node as string | undefined;
  const seen = new Set<string>();
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(mapping[cur]!);
    cur = mapping[cur]!.parent as string | undefined;
  }
  if (chain.length === 0) chain.push(...Object.values(mapping));
  else chain.reverse();
  const turns: ParsedConversation['turns'] = [];
  for (const node of chain) {
    const msg = node.message as Record<string, unknown> | null | undefined;
    if (!msg) continue;
    const role = String((msg.author as { role?: string } | undefined)?.role ?? '');
    if (role !== 'user' && role !== 'assistant') continue;
    const parts = ((msg.content as { parts?: unknown[] } | undefined)?.parts ?? []) as unknown[];
    const text = parts
      .map((p) => (typeof p === 'string' ? p : ''))
      .join('\n')
      .trim();
    if (text) turns.push({ role: role as 'user' | 'assistant', text });
  }
  const created =
    typeof c.create_time === 'number' ? new Date(c.create_time * 1000).toISOString() : undefined;
  return {
    source: 'chatgpt',
    title: String(c.title || 'Untitled ChatGPT chat'),
    createdAt: created,
    turns,
  };
}

export function parseExport(json: unknown): ParsedConversation[] {
  const list = Array.isArray(json) ? json : json && typeof json === 'object' ? [json] : [];
  const out: ParsedConversation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (Array.isArray(c.chat_messages)) out.push(parseClaudeAi(c));
    else if (c.mapping && typeof c.mapping === 'object') out.push(parseChatGpt(c));
  }
  return out;
}

export function conversationToMarkdown(c: ParsedConversation): string {
  const head = `# ${c.title}\n\n_Imported from ${c.source}${c.createdAt ? ` · ${c.createdAt.slice(0, 10)}` : ''} · read-only_\n`;
  const body = c.turns
    .map((t) => `\n## ${t.role === 'user' ? 'You' : 'Assistant'}\n\n${t.text}\n`)
    .join('');
  return head + body;
}
