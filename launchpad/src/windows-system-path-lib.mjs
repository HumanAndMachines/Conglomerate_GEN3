import { win32 } from "path";

const unsafeWindowsPathSegment = /[<>:"|?*\u0000-\u001f]/;

export function trustedWindowsSystemRoot(env = process.env) {
  const raw = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("SystemRoot/WINDIR is required for a trusted Windows system executable.");
  }

  const candidate = raw.trim().replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(candidate) || candidate.startsWith("\\\\")) {
    throw new Error("SystemRoot/WINDIR must be an absolute local Windows drive path.");
  }
  const segments = candidate.slice(3).split("\\").filter(Boolean);
  if (
    segments.some((segment) => segment === "." || segment === ".." || unsafeWindowsPathSegment.test(segment))
  ) {
    throw new Error("SystemRoot/WINDIR contains an unsafe Windows path segment.");
  }

  return win32.normalize(candidate);
}

export function trustedWindowsSystemExecutable(parts, env = process.env) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.some((part) =>
    typeof part !== "string"
    || part === ""
    || part === "."
    || part === ".."
    || part.includes("/")
    || part.includes("\\")
    || unsafeWindowsPathSegment.test(part)
  )) {
    throw new Error("Trusted Windows executable path contains an unsafe segment.");
  }
  return win32.join(trustedWindowsSystemRoot(env), ...parts);
}
