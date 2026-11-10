"""Collect corresponding sources for the exact API/Web images before distribution."""

import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
import urllib.request
from pathlib import Path


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def download(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url, headers={"User-Agent": "ShopMate-source-bundle"}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        with target.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    return {"url": url, "file": target.name, "sha256": sha256(target)}


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def apk_packages(text):
    return [
        fields
        for block in text.split("\n\n")
        if (fields := dict(re.findall(r"^([PVLoc]):(.*)$", block, re.M)))
    ]


def collect(api, web, output):
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"images": {}, "downloads": [], "alpineSources": []}
    origins = {}
    for name, image in [("api", api), ("web", web)]:
        metadata = json.loads(run("docker", "image", "inspect", image))[0]
        manifest["images"][name] = {
            "id": metadata["Id"],
            "revision": metadata["Config"]["Labels"][
                "org.opencontainers.image.revision"
            ],
        }
        installed = run(
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "cat",
            image,
            "/lib/apk/db/installed",
        )
        packages = apk_packages(installed)
        (output / f"{name}-apk.json").write_text(json.dumps(packages, indent=2) + "\n")
        for package in packages:
            if package["o"] == "nginx":
                version = package["V"].split("-r", 1)[0]
                manifest["downloads"].append(
                    download(
                        f"https://nginx.org/download/nginx-{version}.tar.gz",
                        output / f"nginx-{version}.tar.gz",
                    )
                )
            else:
                origins[(package["o"], package["c"])] = package

    recipes = output / "alpine"
    recipes.mkdir()
    git_dir = output.parent / (output.name + "-aports.git")
    subprocess.run(["git", "init", "--bare", str(git_dir)], check=True)
    subprocess.run(
        ["git", "-C", str(git_dir), "config", "core.autocrlf", "false"], check=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(git_dir),
            "remote",
            "add",
            "origin",
            "https://github.com/alpinelinux/aports.git",
        ],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(git_dir), "config", "remote.origin.promisor", "true"],
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(git_dir),
            "config",
            "remote.origin.partialclonefilter",
            "blob:none",
        ],
        check=True,
    )
    for (origin, commit), package in sorted(origins.items()):
        print(f"Collecting Alpine source: {origin}@{commit}", flush=True)
        if not re.fullmatch(r"[a-zA-Z0-9+_.-]+", origin) or not re.fullmatch(
            r"[a-f0-9]{40}", commit
        ):
            raise ValueError("Invalid Alpine source identity")
        subprocess.run(
            [
                "git",
                "-C",
                str(git_dir),
                "fetch",
                "--depth=1",
                "--filter=blob:none",
                "origin",
                commit,
            ],
            check=True,
        )
        paths = run("git", "-C", str(git_dir), "ls-tree", "-r", "--name-only", commit)
        matches = [p for p in paths.splitlines() if p.endswith(f"/{origin}/APKBUILD")]
        if len(matches) != 1:
            raise ValueError(f"Cannot locate exact recipe for {origin}@{commit}")
        recipe = matches[0].removesuffix("/APKBUILD")
        target = recipes / f"{origin}-{commit}"
        target.mkdir()
        archive = subprocess.check_output(
            [
                "git",
                "-C",
                str(git_dir),
                "archive",
                f"{commit}:{recipe}",
            ]
        )
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(target, filter="data")
        manifest["alpineSources"].append(
            {
                "origin": origin,
                "commit": commit,
                "recipe": recipe,
                "directory": target.name,
                "license": package["L"],
            }
        )

    # Use Alpine's checksum-aware source fetcher, not a second APKBUILD parser.
    # Only this new output directory is writable in the disposable helper.
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--env",
            "DISTFILES_MIRROR=https://distfiles.alpinelinux.org/distfiles/v3.24",
            "--mount",
            f"type=bind,source={output.resolve()},target=/sources",
            "alpine:3.24",
            "sh",
            "-ec",
            "apk add --no-cache abuild git; "
            + "for recipe in /sources/alpine/*; do "
            + 'cd "$recipe"; mkdir distfiles; '
            + 'SRCDEST="$recipe/distfiles" abuild -F fetch verify; done',
        ],
        check=True,
    )

    library = json.loads(
        run(
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "node",
            api,
            "-e",
            "const fs=require('fs');const p='node_modules/@img/sharp-libvips-linuxmusl-x64/';"
            "console.log(JSON.stringify({package:JSON.parse(fs.readFileSync(p+'package.json')),"
            "versions:JSON.parse(fs.readFileSync(p+'versions.json'))}))",
        )
    )
    version = library["package"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Unexpected sharp-libvips version")
    sharp = output / "sharp-libvips"
    sharp.mkdir()
    base = f"https://raw.githubusercontent.com/lovell/sharp-libvips/v{version}/"
    for filename in [
        "versions.properties",
        "build/posix.sh",
        "THIRD-PARTY-NOTICES.md",
        "LICENSE",
    ]:
        manifest["downloads"].append(download(base + filename, sharp / filename))
    installed_notice = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "cat",
            api,
            "/app/licenses/sharp-libvips-NOTICES.txt",
        ]
    )
    if installed_notice != (sharp / "THIRD-PARTY-NOTICES.md").read_bytes():
        raise ValueError(
            "Installed sharp-libvips notice differs from its source version"
        )
    manifest["downloads"].append(
        download(
            f"https://codeload.github.com/lovell/sharp-libvips/tar.gz/refs/tags/v{version}",
            sharp / f"sharp-libvips-v{version}.tar.gz",
        )
    )
    properties = dict(
        re.findall(
            r"^(VERSION_\w+)=(\S+)$", (sharp / "versions.properties").read_text(), re.M
        )
    )
    for key, value in library["versions"].items():
        prop = "VERSION_" + key.upper().replace("-", "_")
        if properties[prop] != value:
            raise ValueError(f"sharp-libvips source version mismatch: {key}")
    urls = []
    for line in (sharp / "build/posix.sh").read_text().splitlines():
        if not line.lstrip().startswith("$CURL ") or " | " not in line:
            continue
        url = line.strip().removeprefix("$CURL ").split(" | ", 1)[0]
        url = re.sub(
            r"\$\(without_patch \$(VERSION_\w+)\)",
            lambda m: properties[m[1]].rsplit(".", 1)[0],
            url,
        )
        url = re.sub(
            r"\$\(without_prerelease \$(VERSION_\w+)\)",
            lambda m: properties[m[1]].split("-", 1)[0],
            url,
        )
        url = re.sub(
            r"\$\{(VERSION_\w+)//\./([_-])\}",
            lambda m: properties[m[1]].replace(".", m[2]),
            url,
        )
        url = re.sub(r"\$\{(VERSION_\w+)\}", lambda m: properties[m[1]], url)
        if "$" in url or not url.startswith("https://"):
            raise ValueError(f"Unresolved sharp-libvips source URL: {url}")
        urls.append(url)
    if len(urls) < len(library["versions"]):
        raise ValueError("Incomplete sharp-libvips source list")
    for index, url in enumerate(urls):
        print(f"Collecting sharp-libvips source: {url}", flush=True)
        manifest["downloads"].append(
            download(url, sharp / "sources" / f"{index:02d}-{url.rsplit('/', 1)[-1]}")
        )

    node_version = run(
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        api,
        "--version",
    )
    manifest["downloads"].append(
        download(
            f"https://nodejs.org/dist/{node_version}/node-{node_version}.tar.xz",
            output / f"node-{node_version}.tar.xz",
        )
    )
    notices = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "sh",
            api,
            "-ec",
            "find node_modules -type f \\( -iname '*license*' -o -iname '*notice*' -o -name package.json \\) > /tmp/notices; "
            + "tar -czf - -T /tmp/notices /usr/local/LICENSE",
        ]
    )
    (output / "npm-notices.tar.gz").write_bytes(notices)
    web_notices = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "tar",
            web,
            "-czf",
            "-",
            "/usr/share/nginx/html/licenses",
            "/usr/share/nginx/html/images/credits.json",
        ]
    )
    (output / "browser-notices.tar.gz").write_bytes(web_notices)
    (output / "README.md").write_bytes(
        (
            Path(__file__).resolve().parents[1] / "docs/container-distribution.md"
        ).read_bytes()
    )
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    checksums = [
        f"{sha256(p)}  {p.relative_to(output).as_posix()}"
        for p in sorted(output.rglob("*"))
        if p.is_file()
    ]
    (output / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True)
    parser.add_argument("--web", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    collect(args.api, args.web, args.output)
