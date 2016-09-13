'use strict';

const cli = require(`${__dirname}/lib/cli`);
const cluster_discovery = require(`${__dirname}/cluster_discovery`);
const follower = require(`${__dirname}/lib/follower`);
const leader = require(`${__dirname}/lib/leader`);

const _ = require('lodash');
const ContainershipPlugin = require('containership.plugin');

module.exports = new ContainershipPlugin({
    type: ['core', 'cli'],
    name: 'cloud',

    initialize: function(core) {
        let config = this.get_config('core');

        console.log("Url: " + config.cloud_api_url)

        if(_.has(core, 'logger')) {
            core.logger.register('containership-cloud');

            cluster_discovery.discover(function(err, cidr) {
                if(!err) {
                    core.cluster.legiond.options.network.cidr = cidr;
                    core.cluster.legiond.actions.discover_peers(cidr);
                }

                if (core.options.mode === 'leader') {
                    leader.initialize(core, config);
                } else {
                    follower.initialize(core, config);
                }
            });

        } else {
            let commands = _.map(cli, function(configuration, command) {
                configuration.name = command;
                return configuration;
            });

            return {
                commands: commands,
                middleware: [
                    function(options, fn) {
                        if(options.url.indexOf('https://api.containership.io') == 0) {
                            let original_url = options.url;
                            options.url = [
                                config.cloud_api_url,
                                'v2',
                                'organizations',
                                options.headers['x-containership-cloud-organization'],
                                'clusters',
                                options.headers['x-containership-cloud-cluster'],
                                'proxy'
                            ].join('/');

                            let original_method = options.method;
                            options.method = 'POST';

                            options.headers = _.pick(options.headers, [
                                'authorization'
                            ]);

                            let original_qs = options.qs;
                            options.qs = {};

                            let original_body = options.json;

                            let proxy_url = url.parse(original_url).path.split('/');
                            proxy_url.splice(1, 1);

                            options.json = {
                                url: proxy_url.join('/'),
                                qs: original_qs,
                                method: original_method
                            };

                            if((original_method == 'POST' || original_method == 'PUT') && !_.isUndefined(original_body)) {
                                options.json.data = original_body;
                            }
                        }

                        return fn();
                    }
                ]
            };
        }
    },

    reload: function() {}
});
