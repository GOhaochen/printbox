#!/usr/bin/env bash
# 构建「打印」UPK 安装包。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export GOCACHE=${GOCACHE:-$ROOT/.gocache}
export GOTMPDIR=${GOTMPDIR:-$ROOT/.gotmp}
mkdir -p "$GOCACHE" "$GOTMPDIR"
BUILD=${BUILD_NUM:-1}
VERSION=0.2.17
UGCLI=${UGCLI:-$HOME/.local/bin/ugcli}

echo "==> 清理旧产物"
rm -rf rootfs_common rootfs_amd64 rootfs_arm64 build_dir
mkdir -p rootfs_common/www rootfs_amd64/bin rootfs_amd64/lib rootfs_arm64/bin

echo "==> 编译后端（静态）"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o rootfs_amd64/bin/qsl_print ./cmd/qsl_print
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o rootfs_arm64/bin/qsl_print ./cmd/qsl_print

echo "==> 复制前端资源"
cp web/index.html web/app.js web/style.css rootfs_common/www/
mkdir -p rootfs_common/www/vendor
cp -a web/vendor/pdfjs rootfs_common/www/vendor/
cp -a web/vendor/office rootfs_common/www/vendor/

echo "==> 生成图标（现代风格）"
if [ -f docs/icon-modern.png ]; then
  cp docs/icon-modern.png rootfs_common/icon.png
fi
[ -f rootfs_common/icon.png ] || cp /dev/null rootfs_common/icon.png

echo "==> 设置权限"
chmod 0755 rootfs_amd64/bin/qsl_print rootfs_arm64/bin/qsl_print
chmod 0755 rootfs_amd64/bin/pdftoppm 2>/dev/null || true
find rootfs_amd64/lib -type f -exec chmod 0755 {} \; 2>/dev/null || true
find rootfs_common/www -type f -exec chmod 0644 {} \;
chmod 0644 rootfs_common/icon.png project.yaml

if [ ! -x "$UGCLI" ]; then
  echo "==> 未找到 ugcli（$UGCLI），跳过安装包生成"
  exit 0
fi
echo "==> ugcli check"
"$UGCLI" check
echo "==> ugcli pack --build $BUILD"
"$UGCLI" pack --arch all --build "$BUILD"
echo "==> 完成，产物位于 build_dir/pkgs/upk/"
