// Compatibility module for imports that still use the historical provider name.
// `kiro-cli` remains an HTTPS inference alias; ACP tools live on `kiro-agent`.
export {
  createKiroInferenceAlias as createKiroCliProvider,
  kiroInferenceAlias as kiroCliProvider,
} from './kiro-inference.mjs'
