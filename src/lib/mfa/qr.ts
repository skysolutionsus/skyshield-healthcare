import QRCode from "qrcode";

export function createTotpQrCodeDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
    color: {
      dark: "#0A1628",
      light: "#FFFFFF",
    },
  });
}
