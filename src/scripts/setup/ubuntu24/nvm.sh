#!/usr/bin/env bash

{ # this ensures the entire script is downloaded #

nvm_has() {
  type "$1" > /dev/null 2>&1
}

nvm_echo() {
  command printf %s\\n "$*" 2>/dev/null
}

if [ -z "${BASH_VERSION}" ] || [ -n "${ZSH_VERSION}" ]; then
  nvm_echo >&2 'Error: the install instructions explicitly say to pipe the install script to `bash`; please follow them'
  exit 1
fi

nvm_grep() {
  GREP_OPTIONS='' command grep "$@"
}

nvm_default_install_dir() {
  [ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm"
}

nvm_install_dir() {
  if [ -n "$NVM_DIR" ]; then
    printf %s "${NVM_DIR}"
  else
    nvm_default_install_dir
  fi
}

apt-get update -y
apt-get install -y curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

export NVM_DIR="$(nvm_install_dir)"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

} # this ensures the entire script is downloaded #
