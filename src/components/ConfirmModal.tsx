import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1A2820]/40 dark:bg-black/65 backdrop-blur-[2px] p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-white dark:bg-[#17211C] border border-[#E5E7E2] dark:border-[#27362E] rounded-2xl p-6 shadow-lg"
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                destructive
                  ? 'bg-[#FDF2EC] dark:bg-[#2B1B18] text-[#B83B3B] dark:text-[#F5B0A6]'
                  : 'bg-[#EEF3EC] dark:bg-[#20342A] text-[#1B4332] dark:text-[#9CE0B8]'
              }`}
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-[#1A2820] dark:text-[#EBF2ED]">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="p-1.5 rounded-lg text-[#6B7A70] dark:text-[#9CB0A4] hover:bg-[#F2F4EF] dark:hover:bg-[#223129] transition-colors cursor-pointer"
            aria-label="Close confirmation dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-[#4F5E55] dark:text-[#A5B7AC] leading-relaxed mb-6">
          {message}
        </p>

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-xl border border-[#DCE0D8] dark:border-[#31483B] text-sm font-medium text-[#34443A] dark:text-[#C5D5CC] hover:bg-[#F4F5F2] dark:hover:bg-[#223129] transition-colors cursor-pointer whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-xl text-sm font-medium text-white transition-colors cursor-pointer whitespace-nowrap disabled:opacity-60 ${
              destructive
                ? 'bg-[#B83B3B] hover:bg-[#9E2F2F]'
                : 'bg-[#1B4332] dark:bg-[#2D6A4F] hover:bg-[#143325] dark:hover:bg-[#245740]'
            }`}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
