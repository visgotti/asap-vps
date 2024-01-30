#!/bin/bash

apt-get update -y;
echo "install curl";
yes | sudo apt install curl;
echo "install nvm";
curl https://raw.githubusercontent.com/creationix/nvm/master/install.sh | bash;
source ~/.nvm/nvm.sh

echo "install node v20.11.0;";
nvm install 20.11.0;
nvm use 20.11.0;
