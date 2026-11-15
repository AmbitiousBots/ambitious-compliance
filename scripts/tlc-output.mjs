export const distinctStateCount = (output) => {
  const summaries = [...output.matchAll(/^([\d,]+) states? generated, ([\d,]+) distinct states? found, [\d,]+ states? left on queue\.?$/gm)];
  const count = summaries.at(-1)?.[2];
  return count === undefined ? null : Number(count.replaceAll(",", ""));
};
