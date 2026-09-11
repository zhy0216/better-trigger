import React from 'react';
import { createPortal } from 'react-dom';

/** Native dialogs keep focus and pointer interaction inside the active layer. */
export function Modal({ open, onClose, label, children, className, id }: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const backdropDown = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    // jsdom has no dialog implementation; native showModal handles focus
    // containment and the inert background in actual browsers.
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLElement>('button, [href], input, select, [tabindex="0"]')?.focus();
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open, ref]);

  if (!open) return null;
  const outside = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  return createPortal(
    <dialog ref={ref} id={id} aria-label={label} aria-modal="true" className={className}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const dialog = event.currentTarget;
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]',
        )).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); return; }
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}
      onMouseDown={(event) => { backdropDown.current = outside(event); }}
      onClick={(event) => {
        if (backdropDown.current && outside(event)) onClose();
        backdropDown.current = false;
      }}>
      {children}
    </dialog>,
    document.body,
  );
}
