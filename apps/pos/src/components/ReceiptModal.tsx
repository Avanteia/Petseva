import { Printer } from 'lucide-react';
import { useEffect } from 'react';
import { Button, Modal } from './ui';

/** Shows the plain-text ticket and triggers browser printing (the print CSS shows only .print-area). */
export function ReceiptModal({ text, title, onClose, autoPrint }: { text: string | null; title: string; onClose: () => void; autoPrint?: boolean }) {
  useEffect(() => {
    if (text && autoPrint) setTimeout(() => window.print(), 150);
  }, [text, autoPrint]);
  if (!text) return null;
  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={title}
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={() => window.print()} autoFocus>
              <Printer size={16} /> Print
            </Button>
          </>
        }
      >
        <pre className="receipt rounded-lg bg-white p-4 text-black">{text}</pre>
      </Modal>
      <div className="print-area">
        <pre className="receipt">{text}</pre>
      </div>
    </>
  );
}
