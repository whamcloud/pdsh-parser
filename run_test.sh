#!/usr/bin/env bash

. ~/.nvm/nvm.sh

NODE_VERSIONS="
4
6
stable
"

for node_version in $NODE_VERSIONS
do
    nvm use $node_version
    rm -rf node_modules
    npm i
    npm run postversion
    npm run cover -- --reporter=cobertura
    mv ./coverage/cobertura-coverage.xml ../coverage
    mv pdsh-parser-results*.xml ../results
done
