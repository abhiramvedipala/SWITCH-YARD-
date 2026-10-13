import ReactMarkdown from 'react-markdown';

/** Isolated so the markdown library is its own chunk (see LazyMd). */
export default function Md({ children }: { children: string }) {
  return <ReactMarkdown>{children}</ReactMarkdown>;
}
