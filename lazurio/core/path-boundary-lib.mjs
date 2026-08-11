import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Lexikální prefix nestačí pro kanonické (realpath) boundary kontroly a na
// Windows selhává i prosté porovnání řetězců kvůli case-insensitive cestám.
// `relative` používá platformní path semantics, odmítne jiný drive/UNC root a
// funguje shodně pro POSIX symlinky i Windows junctiony po jejich rozbalení.
export function isPathDescendant(parent, candidate) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

export function isPathSameOrDescendant(parent, candidate) {
  return (
    isSamePath(parent, candidate)
    || isPathDescendant(parent, candidate)
  );
}

export function isSamePath(left, right) {
  return relative(resolve(left), resolve(right)) === "";
}

// Ověří lexical i kanonickou hranici. Pro budoucí write target lze povolit
// neexistující leaf: pak se rozbalí nejbližší existující parent, takže
// symlink/junction v kterémkoli mezikroku nemůže odvést mkdir/write mimo root.
// `lstat` záměrně rozpozná i rozbitý symlink; takový target nesmí projít jako
// obyčejná neexistující cesta, protože následný write by odkaz mohl následovat.
export async function inspectCanonicalPathBoundary({
  rootPath,
  rootRealPath = null,
  targetPath,
  allowMissingTarget = false,
  allowTargetEqual = false,
}) {
  const absoluteRoot = resolve(rootPath);
  const absoluteTarget = resolve(targetPath);
  const lexicalInside = allowTargetEqual
    ? isPathSameOrDescendant(absoluteRoot, absoluteTarget)
    : isPathDescendant(absoluteRoot, absoluteTarget);
  if (!lexicalInside) {
    return {
      ok: false,
      rootRealPath,
      targetRealPath: null,
      checkedPath: null,
    };
  }

  try {
    const resolvedRoot = rootRealPath ?? await realpath(absoluteRoot);
    const targetStat = await lstatOrNull(absoluteTarget);
    if (targetStat) {
      const targetRealPath = await realpath(absoluteTarget);
      const canonicalInside = allowTargetEqual
        ? isPathSameOrDescendant(resolvedRoot, targetRealPath)
        : isPathDescendant(resolvedRoot, targetRealPath);
      return {
        ok: canonicalInside,
        rootRealPath: resolvedRoot,
        targetRealPath,
        checkedPath: absoluteTarget,
      };
    }
    if (!allowMissingTarget) {
      return {
        ok: false,
        rootRealPath: resolvedRoot,
        targetRealPath: null,
        checkedPath: null,
      };
    }

    const existingParent = await nearestExistingParent(absoluteTarget);
    if (!existingParent) {
      return {
        ok: false,
        rootRealPath: resolvedRoot,
        targetRealPath: null,
        checkedPath: null,
      };
    }
    const parentRealPath = await realpath(existingParent);
    return {
      ok: isPathSameOrDescendant(resolvedRoot, parentRealPath),
      rootRealPath: resolvedRoot,
      targetRealPath: null,
      checkedPath: existingParent,
    };
  } catch {
    return {
      ok: false,
      rootRealPath,
      targetRealPath: null,
      checkedPath: null,
    };
  }
}

async function nearestExistingParent(path) {
  let candidate = dirname(path);
  while (true) {
    if (await lstatOrNull(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
