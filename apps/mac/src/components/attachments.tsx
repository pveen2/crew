// Images in messages: the attach button, paste and drop handling, the tray of
// picked images under construction, and the images shown in a thread.

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import type { Attachment } from '@crew/protocol';
import { IconButton } from '@crew/ui';
import { attachmentUrl } from '../store';

const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILES = 8;
const MAX_BYTES = 10 * 1024 * 1024;

/** State and handlers for images attached to a message that is being written. */
export function useAttachments() {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const add = (list: Iterable<File>) => {
    const picked = [...list];
    const images = picked.filter((f) => ACCEPT.includes(f.type));
    const problems: string[] = [];
    if (images.length < picked.length) problems.push('Only PNG, JPEG, GIF and WebP images can be attached.');
    const small = images.filter((f) => f.size <= MAX_BYTES);
    if (small.length < images.length) problems.push('Images larger than 10 MB were skipped.');
    setFiles((cur) => {
      const next = [...cur, ...small];
      if (next.length > MAX_FILES) problems.push(`At most ${MAX_FILES} images per message.`);
      return next.slice(0, MAX_FILES);
    });
    setError(problems.join(' '));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    add(pasted);
  };

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      add(e.dataTransfer.files);
    },
  };

  const button = (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add(e.target.files);
          e.target.value = '';
        }}
      />
      <IconButton icon="attach" label="Attach images" title="Attach images (or paste / drop them)" onClick={() => input.current?.click()} />
    </>
  );

  return {
    files,
    error,
    button,
    onPaste,
    dropProps,
    remove: (i: number) => setFiles((cur) => cur.filter((_, j) => j !== i)),
    clear: () => {
      setFiles([]);
      setError('');
    },
  };
}

/** Thumbnails of the images about to be sent, each with a remove button. */
export function AttachmentTray({ files, onRemove }: { files: File[]; onRemove: (i: number) => void }) {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  if (!files.length) return null;
  return (
    <div className="attach-tray">
      {files.map((f, i) => (
        <span key={urls[i]} className="attach-thumb" title={f.name}>
          <img src={urls[i]} alt={f.name} />
          <IconButton icon="close" label={`Remove ${f.name}`} className="attach-remove" onClick={() => onRemove(i)} />
        </span>
      ))}
    </div>
  );
}

/** Images attached to a message in a thread. Click to open full size. */
export function MessageImages({ threadId, attachments }: { threadId: string; attachments: Attachment[] }) {
  return (
    <div className="message-images">
      {attachments.map((a) => (
        <MessageImage key={a.file} threadId={threadId} attachment={a} />
      ))}
    </div>
  );
}

function MessageImage({ threadId, attachment }: { threadId: string; attachment: Attachment }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    attachmentUrl(threadId, attachment.file).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [threadId, attachment.file]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  let body: ReactNode;
  if (failed) body = <span className="message-image-missing">{attachment.name}</span>;
  else if (!url) body = <span className="message-image-loading" />;
  else body = <img src={url} alt={attachment.name} />;

  return (
    <>
      <button type="button" className="message-image" title={attachment.name} onClick={() => url && setOpen(true)}>
        {body}
      </button>
      {open && url ? (
        <div className="image-lightbox" role="dialog" aria-label={attachment.name} onClick={() => setOpen(false)}>
          <img src={url} alt={attachment.name} />
        </div>
      ) : null}
    </>
  );
}
