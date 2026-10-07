import type { LibraryPdf, Subject } from '../types';

export const MAX_LIBRARY_PDF_SIZE = 100 * 1024 * 1024;

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** Stable, collision-free id for a library entry (works on http origins too). */
export function newLibraryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validateLibraryFile(file: File): string {
  if (!isPdfFile(file)) return 'Only PDF files can be added to your library.';
  if (file.size > MAX_LIBRARY_PDF_SIZE) return 'This PDF is larger than 100 MB. Choose a smaller file.';
  return '';
}

/** Drop the extension so a library title reads like a note name, not a file name. */
export function pdfTitle(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '').trim() || fileName;
}

export function formatLibraryDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `Today · ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function sortLibrary(items: LibraryPdf[]): LibraryPdf[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sessionLibraryItem(file: File, subject: Subject): LibraryPdf {
  const now = Date.now();
  return {
    id: newLibraryId(),
    name: file.name,
    subject,
    size: file.size,
    storagePath: '',
    createdAt: now,
    updatedAt: now,
    sessionOnly: true,
    file,
  };
}
