//! Embed the commit this binary is built from as `PBS_GIT_SHA`, so that
//! `status` and upgrade logs can tell two builds of the same version apart.
//! Outside a git checkout it is "unknown".

use std::path::PathBuf;
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8(out.stdout).ok()?.trim().to_string())
}

fn main() {
    let sha = git(&["rev-parse", "--short=10", "HEAD"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=PBS_GIT_SHA={sha}");
    // Rebuild when HEAD moves: HEAD itself (branch switch) and the ref it
    // names (a commit). Worktrees keep HEAD in their own git dir and refs in
    // the common one.
    if let (Some(dir), Some(common)) = (git(&["rev-parse", "--git-dir"]), git(&["rev-parse", "--git-common-dir"])) {
        let (dir, common) = (PathBuf::from(dir), PathBuf::from(common));
        println!("cargo:rerun-if-changed={}", dir.join("HEAD").display());
        println!("cargo:rerun-if-changed={}", common.join("packed-refs").display());
        if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={}", common.join(r).display());
        }
    }
}
