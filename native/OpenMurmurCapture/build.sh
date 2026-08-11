#!/bin/bash
set -euo pipefail
umask 077

native_dir="$(cd -P "$(dirname "$0")" && pwd -P)"
identity="${OPENMURMUR_CAPTURE_CODESIGN_IDENTITY:--}"
target="${OPENMURMUR_CAPTURE_TARGET:-arm64-apple-macos14.0}"

compute_source_digest() {
    local work_dir="$1"
    local source_file_list="$work_dir/source-files.txt"
    local source_manifest="$work_dir/source-manifest.txt"
    local source_file
    local relative_file
    local checksum_line
    local checksum
    local source_digest_line

    : > "$source_file_list"
    printf '%s\n' \
        "Info.plist" \
        "OpenMurmurCapture.entitlements" \
        "build.sh" >> "$source_file_list"
    while IFS= read -r source_file; do
        printf '%s\n' "${source_file#"$native_dir/"}" >> "$source_file_list"
    done < <(LC_ALL=C /usr/bin/find "$native_dir/Sources" -type f -name '*.swift' -print)
    LC_ALL=C /usr/bin/sort -o "$source_file_list" "$source_file_list"

    : > "$source_manifest"
    while IFS= read -r relative_file; do
        checksum_line="$(/usr/bin/shasum -a 256 "$native_dir/$relative_file")"
        checksum="${checksum_line%% *}"
        printf '%s  %s\n' "$checksum" "$relative_file" >> "$source_manifest"
    done < "$source_file_list"
    source_digest_line="$(/usr/bin/shasum -a 256 "$source_manifest")"
    printf '%s\n' "${source_digest_line%% *}"
}

remove_digest_scratch() {
    local path="$1"
    case "$path" in
        /private/tmp/openmurmur-source-digest.*) ;;
        *) return 1 ;;
    esac
    [[ -d "$path" && ! -L "$path" ]] || return 1
    rm -rf -- "$path"
}

if [[ "${1:-}" == "--source-digest" ]]; then
    if [[ "$#" -ne 1 ]]; then
        echo "usage: build.sh [--source-digest]" >&2
        exit 64
    fi
    digest_work_dir="$(mktemp -d /private/tmp/openmurmur-source-digest.XXXXXX)"
    chmod 0700 "$digest_work_dir"
    cleanup_digest() {
        local result=$?
        trap - EXIT
        if ! remove_digest_scratch "$digest_work_dir"; then
            echo "source-digest scratch preserved for inspection: $digest_work_dir" >&2
            [[ "$result" -ne 0 ]] || result=74
        fi
        exit "$result"
    }
    trap cleanup_digest EXIT
    compute_source_digest "$digest_work_dir"
    exit 0
fi
if [[ "$#" -ne 0 ]]; then
    echo "usage: build.sh [--source-digest]" >&2
    exit 64
fi

requested_build_dir="${OPENMURMUR_CAPTURE_BUILD_DIR:-$native_dir/build}"
if [[ "$requested_build_dir" != /* ]]; then
    requested_build_dir="$PWD/$requested_build_dir"
fi
while [[ "$requested_build_dir" != "/" && "$requested_build_dir" == */ ]]; do
    requested_build_dir="${requested_build_dir%/}"
done
case "$requested_build_dir" in
    */../*|*/..|*/./*|*/.)
        echo "build directory must not contain . or .. path components" >&2
        exit 64
        ;;
esac
case "$requested_build_dir" in
    "$native_dir"/*|/private/tmp/*) ;;
    *)
        echo "build directory must be inside native/OpenMurmurCapture or /private/tmp" >&2
        exit 64
        ;;
esac

assert_real_directory_tree() {
    local path="$1"
    local current=""
    local component
    local components
    IFS='/' read -r -a components <<< "${path#/}"
    for component in "${components[@]}"; do
        [[ -n "$component" ]] || continue
        current="$current/$component"
        if [[ -L "$current" || ! -d "$current" ]]; then
            echo "build directory has a missing or symlinked parent: $current" >&2
            return 1
        fi
    done
}

build_parent="${requested_build_dir%/*}"
[[ -n "$build_parent" ]] || build_parent="/"
assert_real_directory_tree "$build_parent"
if [[ -e "$requested_build_dir" || -L "$requested_build_dir" ]]; then
    if [[ -L "$requested_build_dir" || ! -d "$requested_build_dir" ]]; then
        echo "build directory must be a real directory, not a file or symlink" >&2
        exit 64
    fi
else
    mkdir -m 0700 "$requested_build_dir"
fi
assert_real_directory_tree "$requested_build_dir"
build_dir="$(cd -P "$requested_build_dir" && pwd -P)"
if [[ "$build_dir" != "$requested_build_dir" ]]; then
    echo "build directory must already be a physical path without aliases" >&2
    exit 64
fi

app_dir="$build_dir/OpenMurmur Capture.app"
if [[ -L "$app_dir" || ( -e "$app_dir" && ! -d "$app_dir" ) ]]; then
    echo "refusing a symlink or non-directory app destination: $app_dir" >&2
    exit 64
fi

lock_dir="$build_dir/.OpenMurmurCapture.build.lock"
if ! mkdir -m 0700 "$lock_dir" 2>/dev/null; then
    echo "another native capture build is active, or the build lock is unsafe" >&2
    exit 73
fi

stage_root=""
backup_root=""
preserve_stage=false
preserve_backup=false

remove_build_private() {
    local path="$1"
    case "$path" in
        "$build_dir"/.OpenMurmurCapture.stage.*|"$build_dir"/.OpenMurmurCapture.backup.*) ;;
        *) return 1 ;;
    esac
    [[ -d "$path" && ! -L "$path" ]] || return 1
    rm -rf -- "$path"
}

cleanup_build() {
    local result=$?
    trap - EXIT
    if [[ -n "$stage_root" && "$preserve_stage" == false ]]; then
        if ! remove_build_private "$stage_root"; then
            echo "staging directory preserved for inspection: $stage_root" >&2
            [[ "$result" -ne 0 ]] || result=74
        fi
    fi
    if [[ -n "$backup_root" && "$preserve_backup" == false ]]; then
        if ! remove_build_private "$backup_root"; then
            echo "prior app backup preserved for inspection: $backup_root" >&2
            [[ "$result" -ne 0 ]] || result=74
        fi
    fi
    if [[ -d "$lock_dir" && ! -L "$lock_dir" ]]; then
        if ! rmdir "$lock_dir"; then
            echo "build lock could not be removed safely: $lock_dir" >&2
            [[ "$result" -ne 0 ]] || result=74
        fi
    else
        echo "build lock changed unexpectedly: $lock_dir" >&2
        [[ "$result" -ne 0 ]] || result=74
    fi
    exit "$result"
}
trap cleanup_build EXIT

stage_root="$(mktemp -d "$build_dir/.OpenMurmurCapture.stage.XXXXXX")"
chmod 0700 "$stage_root"
staged_app="$stage_root/OpenMurmur Capture.app"
contents_dir="$staged_app/Contents"
executable="$contents_dir/MacOS/OpenMurmurCapture"
mkdir -m 0700 "$staged_app" "$contents_dir" "$contents_dir/MacOS" "$contents_dir/Resources"
cp "$native_dir/Info.plist" "$contents_dir/Info.plist"
/usr/bin/plutil -lint "$contents_dir/Info.plist"

digest_work_dir="$(mktemp -d "$stage_root/source-digest.XXXXXX")"
chmod 0700 "$digest_work_dir"
source_digest="$(compute_source_digest "$digest_work_dir")"
printf '%s\n' "$source_digest" > "$contents_dir/Resources/source.sha256"

module_cache="$stage_root/module-cache"
mkdir -m 0700 "$module_cache"
/usr/bin/xcrun swiftc \
    -O \
    -whole-module-optimization \
    -swift-version 5 \
    -target "$target" \
    -module-cache-path "$module_cache" \
    -framework AppKit \
    -framework AVFoundation \
    "$native_dir/Sources/AudioCapture.swift" \
    "$native_dir/Sources/main.swift" \
    -o "$executable"

codesign_args=(
    --force
    --sign "$identity"
    --options runtime
    --entitlements "$native_dir/OpenMurmurCapture.entitlements"
)
if [[ "$identity" != "-" ]]; then
    codesign_args+=(--timestamp)
fi
/usr/bin/codesign "${codesign_args[@]}" "$staged_app"
/usr/bin/codesign --verify --strict --verbose=2 "$staged_app"
reported_source_digest="$("$executable" --source-digest)"
if [[ "$reported_source_digest" != "$source_digest" ]]; then
    echo "signed source digest mismatch" >&2
    exit 70
fi
"$executable" --self-check

if [[ ! -e "$app_dir" && ! -L "$app_dir" ]]; then
    if ! mv "$staged_app" "$app_dir"; then
        echo "validated app publish failed; no prior app was changed" >&2
        exit 74
    fi
else
    backup_root="$(mktemp -d "$build_dir/.OpenMurmurCapture.backup.XXXXXX")"
    chmod 0700 "$backup_root"
    backup_app="$backup_root/OpenMurmur Capture.app"
    if ! mv "$app_dir" "$backup_app"; then
        echo "could not move the prior app into a private backup; prior app was not replaced" >&2
        exit 74
    fi
    if ! mv "$staged_app" "$app_dir"; then
        if [[ ! -e "$app_dir" && ! -L "$app_dir" ]] && mv "$backup_app" "$app_dir"; then
            echo "validated app publish failed; prior app restored" >&2
            exit 74
        fi
        preserve_stage=true
        preserve_backup=true
        echo "CRITICAL: app publish and automatic rollback both failed" >&2
        echo "validated staging app: $staged_app" >&2
        echo "prior app backup: $backup_app" >&2
        echo "destination requiring inspection: $app_dir" >&2
        exit 74
    fi
fi

echo "$app_dir"
