/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 根地址（生产部署时设置，如 http://localhost:8000） */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
