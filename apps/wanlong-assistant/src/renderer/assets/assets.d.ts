/** Vite resolves imported images to a URL (hashed file in the build, or an inline data: URI for small ones). */
declare module '*.png' {
  const src: string;
  export default src;
}
