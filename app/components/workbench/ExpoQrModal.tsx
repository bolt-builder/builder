import React, { lazy, Suspense } from 'react';
import { Dialog, DialogTitle, DialogDescription, DialogRoot } from '~/components/ui/Dialog';
import { useStore } from '@nanostores/react';
import { expoUrlAtom } from '~/lib/stores/qrCode';

const QrCode = lazy(() => import('react-qrcode-logo').then((mod) => ({ default: mod.QRCode })));

interface ExpoQrModalProps {
  open: boolean;
  onClose: () => void;
}

export const ExpoQrModal: React.FC<ExpoQrModalProps> = ({ open, onClose }) => {
  const expoUrl = useStore(expoUrlAtom);

  return (
    <DialogRoot open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog
        className="text-center !flex-col !mx-auto !text-center !max-w-md"
        showCloseButton={true}
        onClose={onClose}
      >
        <div className="border !border-bolt-elements-borderColor flex flex-col gap-5 justify-center items-center p-6 bg-bolt-elements-background-depth-2 rounded-md">
          <div className="i-bolt:expo-brand h-10 w-full invert dark:invert-none"></div>
          <DialogTitle className="text-bolt-elements-textTertiary text-lg font-semibold leading-6">
            Preview on your own mobile device
          </DialogTitle>
          <DialogDescription className="bg-bolt-elements-background-depth-3 max-w-sm rounded-md p-1 border border-bolt-elements-borderColor">
            Scan this QR code with the Expo Go app on your mobile device to open your project.
          </DialogDescription>
          <div className="my-6 flex flex-col items-center">
            {expoUrl ? (
              <Suspense
                fallback={
                  <div className="w-[250px] h-[250px] flex items-center justify-center text-bolt-elements-textSecondary">
                    Loading QR code...
                  </div>
                }
              >
                <QrCode
                  logoImage="/favicon.svg"
                  removeQrCodeBehindLogo={true}
                  logoPadding={3}
                  logoHeight={50}
                  logoWidth={50}
                  logoPaddingStyle="square"
                  style={{
                    borderRadius: 16,
                    padding: 2,
                    backgroundColor: '#1e3a8a',
                  }}
                  value={expoUrl}
                  size={200}
                />
              </Suspense>
            ) : (
              <div className="text-gray-500 text-center">No Expo URL detected.</div>
            )}
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
};
