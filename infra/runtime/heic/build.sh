#!/bin/sh
set -eu
cd /src
curl --fail --silent --show-error --location https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz --output libde265.tar.gz
curl --fail --silent --show-error --location https://github.com/strukturag/libheif/releases/download/v1.23.6/libheif-1.23.6.tar.gz --output libheif.tar.gz
printf '%s\n' '554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905  libde265.tar.gz' '4484346dc5995319dbc11e3a1c35d0a2ec46511ce370900869337fd2c7033125  libheif.tar.gz' | sha256sum --check --strict
tar -xzf libde265.tar.gz
tar -xzf libheif.tar.gz
cmake -S libde265-1.1.3 -B de265-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/longball-heic -DCMAKE_INSTALL_LIBDIR=lib -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF -DENABLE_AVX512=OFF
cmake --build de265-build --parallel 2
cmake --install de265-build
cmake -S libheif-1.23.6 -B heif-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS_RELEASE='-O2 -DNDEBUG' -DCMAKE_INSTALL_PREFIX=/opt/longball-heic -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH=/opt/longball-heic \
 -DENABLE_PLUGIN_LOADING=OFF -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF -DWITH_X265=OFF -DWITH_X264=OFF -DWITH_OpenH264_DECODER=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF -DWITH_DAV1D=OFF -DWITH_LIBSHARPYUV=OFF -DWITH_EXAMPLES=OFF -DBUILD_TESTING=OFF -DWITH_GDK_PIXBUF=OFF
cmake --build heif-build --parallel 2
cmake --install heif-build
