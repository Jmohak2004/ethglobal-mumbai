// Build-only stub. Several SDKs pulled in by RainbowKit's wagmi connectors (Base Account via
// @coinbase/cdp-sdk) import optional @x402/* peers that are not installed. Those code paths
// (x402 payments, CDP smart wallets) are never used by ARENA, so every @x402/* specifier resolves
// to this module. The named exports exist only so static imports bundle; they are never called.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const toClientEvmSigner: any = undefined;
export const AuthCaptureEvmScheme: any = undefined;
export const BatchSettlementEvmScheme: any = undefined;
export const ExactEvmScheme: any = undefined;
export const ExactEvmSchemeV1: any = undefined;
export const ExactSvmScheme: any = undefined;
export const ExactSvmSchemeV1: any = undefined;
export const UptoEvmScheme: any = undefined;
export const UptoSvmScheme: any = undefined;
export const HTTPFacilitatorClient: any = undefined;
export const PaymentRequirementsV1Schema: any = undefined;
export const PaymentRequirementsV2Schema: any = undefined;
export const BUILDER_CODE: any = undefined;
export const BUILDER_CODE_PATTERN: any = undefined;
export const BUILDER_CODE_SCHEMA: any = undefined;
export const BuilderCodeClientExtension: any = undefined;
export const builderCodeResourceServerExtension: any = undefined;
export const bazaarResourceServerExtension: any = undefined;
export const x402Client: any = undefined;
export const x402ResourceServer: any = undefined;
export const x402HTTPResourceServer: any = undefined;
