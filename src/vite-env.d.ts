/// <reference types="vite/client" />

/** Vite Worker 导入的类型声明。 */
declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

declare module '*?worker&inline' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
