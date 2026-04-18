#!/bin/bash

apt-get update -y;
echo "install curl";
yes | sudo apt install curl;
echo "install nvm";
curl https://raw.githubusercontent.com/creationix/nvm/master/install.sh | bash;
source ~/.nvm/nvm.sh

echo "install node v22.14.0;";
nvm install 22.14.0;
nvm use 22.14.0;
