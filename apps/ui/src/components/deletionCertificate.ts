/**
 * Downloads a channel account's deletion certificate (DEL-3, T-0403 route). Shared by Buyer data
 * requests and Connections, so neither route module imports the other.
 */
import { privacyApi, saveFile } from '../auth/api.ts';
import { useToast } from '../kit/Toast.tsx';
import { londonDayKey } from '../lib/format.ts';

export function useCertificateDownload() {
  const toast = useToast();
  return async (account: { id: string; name: string }) => {
    try {
      const r = await privacyApi.deletionCertificate(account.id);
      if (!r.ok) throw new Error(String(r.status));
      saveFile(r.body as Blob, `deletion-certificate-${account.id}-${londonDayKey()}.txt`);
    } catch {
      toast({
        title: 'The certificate could not be downloaded',
        description: `Try again for ${account.name}.`,
        tone: 'error',
      });
    }
  };
}
