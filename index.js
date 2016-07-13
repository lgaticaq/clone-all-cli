'use strict';

const OAuth = require('oauth');
const http = require('http');
const open = require('open');
const exec = require('child_process').exec;
const url = require('url');
const path = require('path');
const crypto = require('crypto');
const qs = require('querystring');
const rp = require('request-promise');
const Preferences = require('preferences');
const flattenDeep = require('lodash/flattenDeep');
const secrets = require('./secrets.json');

const OAuth2 = OAuth.OAuth2;

const prefs = new Preferences('com.lgaticaq.clone-all-cli', {bitbucket: {}, github: {}});

const getAccessToken = () => {
  return new Promise((resolve, reject) => {
    if (prefs.bitbucket.accessToken) {
      const expire = new Date(prefs.bitbucket.expire);
      if (new Date < expire) {
        resolve(prefs.bitbucket.accessToken);
      } else {
        refreshToken().then(token => resolve(token)).catch(err => reject(err));
      }
    } else {
      const baseUri = 'https://bitbucket.org/';
      const authorizePath = 'site/oauth2/authorize';
      const accessTokenPath = 'site/oauth2/access_token';
      const oauth2 = new OAuth2(secrets.bitbucket.client.id, secrets.bitbucket.client.secret, baseUri, authorizePath, accessTokenPath, null);
      const authURL = oauth2.getAuthorizeUrl({response_type: 'code'});
      open(authURL);
      const server = http.createServer((req, res) => {
        const p = req.url.split('/');
        const pLen = p.length;
        if (pLen === 2 && p[1].indexOf('code') === 0) {
          const qsObj = qs.parse(p[1].split('?')[1]) || {};
          const accessTokenParams = {grant_type: 'authorization_code'};
          oauth2.getOAuthAccessToken(qsObj.code, accessTokenParams, (err, accessToken, refreshToken, results) => {
            prefs.bitbucket.accessToken = accessToken;
            prefs.bitbucket.refreshToken = refreshToken;
            const expire = new Date();
            expire.setSeconds(3600);
            prefs.bitbucket.expire = expire.toISOString();
            res.end('<code><h1>Authorization Ready, close and return to cli :)</h1></code>');
            server.close();
            if (err) {
              reject(err);
            } else if (results.error) {
              reject(JSON.stringify(results));
            } else {
              resolve(accessToken);
            }
          });
        }
      });
      server.listen(8080);
    }
  });
};

const getAccessTokenGithub = () => {
  return new Promise((resolve, reject) => {
    if (prefs.github.accessToken) {
      const expire = new Date(prefs.github.expire);
      if (new Date < expire) {
        resolve(prefs.github.accessToken);
      } else {
        refreshToken().then(token => resolve(token)).catch(err => reject(err));
      }
    } else {
      const baseUri = 'https://github.com/';
      const authorizePath = 'login/oauth/authorize';
      const accessTokenPath = 'login/oauth/access_token';
      const oauth2 = new OAuth2(secrets.github.client.id, secrets.github.client.secret, baseUri, authorizePath, accessTokenPath, null);
      const authorizeOptions = {
        response_type: 'code',
        scope: ['repo', 'user', 'read:org'],
        state: crypto.randomBytes(256).toString('hex')
      };
      const authURL = oauth2.getAuthorizeUrl(authorizeOptions);
      open(authURL);
      const server = http.createServer((req, res) => {
        const p = req.url.split('/');
        const pLen = p.length;
        if (pLen === 2 && p[1].indexOf('code') === 0) {
          const qsObj = qs.parse(p[1].split('?')[1]) || {};
          const accessTokenParams = {redirect_uri: 'http://localhost:8080/code'};
          oauth2.getOAuthAccessToken(qsObj.code, accessTokenParams, (err, accessToken, refreshToken, results) => {
            prefs.github.accessToken = accessToken;
            prefs.github.refreshToken = refreshToken;
            const expire = new Date();
            expire.setSeconds(3600);
            prefs.github.expire = expire.toISOString();
            res.end('<h1>Authorization Ready, close and return to cli :)</h1>');
            server.close();
            if (err) {
              reject(err);
            } else if (results.error) {
              reject(JSON.stringify(results));
            } else {
              resolve(accessToken);
            }
          });
        }
      });
      server.listen(8080);
    }
  });
};

const refreshToken = () => {
  const options = {
    method: 'POST',
    auth: {user: secrets.bitbucket.client.id, pass: secrets.bitbucket.client.secret},
    uri: 'https://bitbucket.org/site/oauth2/access_token',
    form: {grant_type: 'refresh_token', refresh_token: prefs.bitbucket.refreshToken},
    json: true
  };
  return rp(options).then(data => {
    prefs.bitbucket.accessToken = data.access_token;
    prefs.bitbucket.refreshToken = data.refresh_token;
    const expire = new Date();
    expire.setSeconds(3600);
    prefs.bitbucket.expire = expire.toISOString();
    return data.access_token;
  });
};

const getTeams = accessToken => {
  const options = {
    uri: 'https://bitbucket.org/api/2.0/teams',
    auth: {bearer: accessToken},
    json: true,
    qs: {role: 'member'}
  };
  return rp(options).catch(err => {
    if ((err.statusCode === 401) && prefs.bitbucket.refreshToken) {
      prefs.bitbucket.accessToken = '';
      return refreshToken(prefs.bitbucket.refreshToken).then(token => getTeams(token));
    } else {
      throw err;
    }
  });
};

const getRepoTeam = uri => {
  const repos = [];
  const getRepos = uri => {
    const options = {
      uri: uri,
      auth: {bearer: prefs.bitbucket.accessToken},
      json: true,
      qs: url.parse(uri, true).query
    };
    return rp(options).then(results => {
      repos.push(results.values.map(repo => {
        const uri = repo.links.clone.find(uri => uri.name === 'ssh');
        return {name: repo.name, uri: uri.href};
      }));
      if (results.next) {
        return getRepos(results.next);
      } else {
        return;
      }
    });
  };
  return getRepos(uri).then(() => flattenDeep(repos));
};

const cloneRepos = options => {
  return getAccessToken().then(accessToken => {
    return getTeams(accessToken).then(teams => {
      const promises = teams.values.map(team => {
        return getRepoTeam(`https://bitbucket.org/api/2.0/teams/${team.username}/repositories`);
      });
      return Promise.all(promises).then(flattenDeep);
    });
  }).then(repos => {
    return new Promise((resolve, reject) => {
      const command = repos.map(repo => `git clone ${repo.uri} ${path.join(options.path, repo.name)}`).join(' && ');
      exec(command, (err, stdout, stderr) => {
        if (err) reject(err);
        if (stderr) reject(stderr);
        resolve(stdout);
      });
    });
  });
};

const cloneReposGithub = options => {
  return getAccessTokenGithub().then(() => getRepoTeamGithub('https://api.github.com/user/repos'))
  .then(repos => {
    return new Promise((resolve, reject) => {
      const command = repos.map(repo => `git clone ${repo.uri} ${path.join(options.path, repo.name)}`).join(' && ');
      exec(command, (err, stdout, stderr) => {
        if (err) reject(err);
        if (stderr) reject(stderr);
        resolve(stdout);
      });
    });
  });
};

const getRepoTeamGithub = uri => {
  const repos = [];
  let page = 0;
  const getRepos2 = uri => {
    page++;
    const options = {
      uri: uri,
      auth: {bearer: prefs.github.accessToken},
      json: true,
      qs: {page: page},
      headers: {
        'User-Agent': 'clone-all-cli'
      }
    };
    return rp(options).then(results => {
      if (results.length > 0) {
        repos.push(results.map(x => {
          return {name: x.name, uri: x.ssh_url};
        }));
        return getRepos2(uri);
      } else {
        return;
      }
    });
  };
  return getRepos2(uri).then(() => flattenDeep(repos));
};

cloneReposGithub({path: '~/Proyectos'}).then(() => {
  return cloneRepos({path: '~/Proyectos'});
  process.exit(); // eslint-disable-line
}).catch(err => {
  console.log(err.message); // eslint-disable-line
});
