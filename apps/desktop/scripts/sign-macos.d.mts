import type { SignOptions } from "@electron/osx-sign";

export declare const releaseCertificate: string;
declare const sign: (options: SignOptions) => Promise<void>;
export default sign;
