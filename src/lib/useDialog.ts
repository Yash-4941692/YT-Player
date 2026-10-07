import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableInside(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => !element.hasAttribute('inert') && element.offsetParent !== null);
}

/**
 * Shared behaviour for every modal dialog in the app:
 *   - moves focus into the dialog when it opens and restores it to whatever was
 *     focused before when it closes,
 *   - keeps Tab / Shift+Tab cycling inside the dialog (a focus trap),
 *   - closes on Escape,
 *   - locks background scrolling while open, and restores the previous value.
 *
 * Usage: `const ref = useDialog({ open, onClose })` then put `ref` on the dialog
 * element (the one carrying role="dialog").
 */
export function useDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const container = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Move focus inside the dialog so screen readers and the keyboard start there.
    const initial = container ? focusableInside(container)[0] : null;
    (initial ?? container)?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A small popover inside the dialog (a sticky-note editor, for example) can claim
        // Escape for itself with data-escape-stop, so closing it does not close the dialog.
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-escape-stop]')) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = focusableInside(dialog);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // Send focus back to the button/link that opened the dialog.
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open]);

  return dialogRef;
}
