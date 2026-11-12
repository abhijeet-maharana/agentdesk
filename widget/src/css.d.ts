// esbuild loads .css files as text (widget/build.mjs); embed.tsx puts it in the shadow root.
declare module '*.css' {
  const css: string;
  export default css;
}
