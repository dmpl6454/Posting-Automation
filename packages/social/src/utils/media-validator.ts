import type { PlatformConstraints } from "../abstract/social.types";

export function validateMediaForPlatform(
  files: Array<{ type: string; size: number }>,
  constraints: PlatformConstraints
): string[] {
  const errors: string[] = [];

  if (files.length > constraints.maxMediaCount) {
    errors.push(`Max ${constraints.maxMediaCount} files allowed`);
  }

  for (const file of files) {
    if (!constraints.supportedMediaTypes.includes(file.type)) {
      errors.push(`Unsupported file type: ${file.type}`);
    }
    if (constraints.maxMediaSize && file.size > constraints.maxMediaSize) {
      errors.push(`File exceeds max size of ${constraints.maxMediaSize} bytes`);
    }
  }

  return errors;
}
