export const ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.csv'] as const;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_FILES_PER_PROJECT = 10;

export interface FileValidationResult {
  accepted: File[];
  errors: string[];
}

export function validateCandidateFiles(
  incoming: FileList | File[],
  existingFiles: Array<{ name: string; size?: number }>,
  maxTotalFiles: number = MAX_FILES_PER_PROJECT
): FileValidationResult {
  const incomingArray = Array.from(incoming);
  const errors: string[] = [];
  const accepted: File[] = [];

  for (const file of incomingArray) {
    const lowerName = file.name.toLowerCase();
    const hasValidExtension = ALLOWED_EXTENSIONS.some((ext) =>
      lowerName.endsWith(ext)
    );

    if (!hasValidExtension) {
      errors.push(
        `"${file.name}" rejected: only PDF, TXT, and CSV files are supported.`
      );
      continue;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      errors.push(
        `"${file.name}" rejected: file exceeds the 10 MB maximum size.`
      );
      continue;
    }

    const isDuplicate =
      existingFiles.some(
        (item) =>
          item.name === file.name &&
          (item.size === undefined || item.size === file.size)
      ) ||
      accepted.some(
        (item) => item.name === file.name && item.size === file.size
      );

    if (isDuplicate) {
      continue;
    }

    if (existingFiles.length + accepted.length >= maxTotalFiles) {
      errors.push(
        `Maximum of ${maxTotalFiles} documents per project reached.`
      );
      break;
    }

    accepted.push(file);
  }

  return { accepted, errors };
}
