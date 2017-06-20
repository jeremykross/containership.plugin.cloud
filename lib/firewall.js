'use strict';

const constants = require('./constants');

const _ = require('lodash');
const async = require('async');
const Tesserarius = require('tesserarius');

class Firewall {

    constructor(host) {
        this.host = host;

        // ensure we get the physical network interface if legiond-interface is set to a virtual interface
        const privateInterface = "";
            //this.core.options['legiond-interface'].split(':')[0];

        this.options = {
            chain: 'ContainerShip',
            initial_rules: [
                {
                    comment: 'Accept all connections on loopback interface',
                    interface: 'lo',
                    policy: 'ACCEPT'
                },
                {
                    comment: 'Accept all connections on docker interface',
                    interface: 'docker0',
                    policy: 'ACCEPT'
                },
                {
                    comment: 'Accept all established and related connections',
                    policy: 'ACCEPT',
                    state: ['ESTABLISHED', 'RELATED']
                },
                {
                    comment: 'Accept connections to legiond management port on private interface',
                    destination_port: 2666,
                    interface: privateInterface,
                    policy: 'ACCEPT',
                    protocol: 'tcp'
                },
                {
                    comment: 'Accept connections to legiond port on private interface',
                    destination_port: 2777,
                    interface: privateInterface,
                    policy: 'ACCEPT',
                    protocol: 'tcp'
                },
                {
                    comment: 'Accept connections to containership API on private interface',
                    interface: privateInterface,
                    destination_port: this.host.getApiPort(),
                    mode: 'leader',
                    policy: 'ACCEPT',
                    protocol: 'tcp'
                }
            ]
        };

        this.tesserarius = new Tesserarius();
        //this.myriad_client = new MyriadClient(this.core);
    }

    enable() {
        //Do a version sanity check here?
        //
        console.log("Enabling");

        const firewallSyncInterval = 5000;

        setTimeout(() => {
            this.host.getApi().getDistributedKey(constants.myriad.FIREWALLS, (firewalls) => {
                console.log("Syncing firewalls: " + JSON.stringify(firewalls));
            });
        }, firewallSyncInterval);


        /*
        this.reset_rules((err) => {
            console.log("Back from reset.");
            if(err) {
                console.log('Cloud Firewall: Unable to reset firewall rules!');
                console.log(err.message);
            } else {
                this.set_rules();

                const firewallSyncInterval = 5000;

                const subscriber = this.myriad_client.subscribe(constants.myriad.FIREWALLS_REGEX);

                subscriber.on('message', (message) => {
                    if(message.type === 'data') {
                        this.set_rules();
                    }
                });

                this.core.cluster.legiond.on('node_added', () => {
                    this.set_rules();
                });
                this.core.cluster.legiond.on('node_removed', () => {
                    this.set_rules();
                });
            }
        });

            */
    }

    set_rules() {
        // setup rule queue if necessary
        if(!this.rule_queue) {
            // force tesserarius.set_rules calls to execute with single concurrency
            this.rule_queue = async.queue((task, callback) => {
                console.log("Updating firewall rules.");

                this.get_cloud_rules((err, cloud_rules) => {
                    const rules = _.union(this.get_initial_rules(), this.get_host_rules(), cloud_rules);
                    this.tesserarius.set_rules(task.chain, rules, callback);
                });
            }, 1);
        }

        this.rule_queue.push({
            chain: this.options.chain
        }, (err) => {
            if(err) {
                console.log('Unable to apply new firewall rules!');
                console.log(err.message);
            } else {
                console.log('Sucessfully applied new firewall rules!');
            }
        });
    }

    get_initial_rules() {
        const rules = [];

        _.forEach(this.options.initial_rules, (rule) => {
            if(rule.mode && this.host.getOperatingMode() === rule.mode || !rule.mode) {
                rules.push(_.omit(rule, 'mode'));
            }
        });

        return rules;
    }

    get_host_rules() {
        const rules = [];
        const peers = []; //this.core.cluster.legiond.get_peers();

        _.forEach(peers, (peer) => {
            if(this.host.isLeader()) {
                _.forEach(_.keys(peer.address), (scope) => {
                    rules.push({
                        comment: 'Accept connections to containership API from containership cluster peers',
                        destination_port: this.host.getApiPort(),
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        source: peer.address[scope]
                    });
                });
            } else {
                _.forEach(_.keys(peer.address), (scope) => {
                    rules.push({
                        comment: 'Accept connections to service discovery port range from containership cluster peers',
                        destination_port: `${this.core.scheduler.options.loadbalancer.min_port}:${this.core.scheduler.options.loadbalancer.max_port}`,
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        source: peer.address[scope]
                    });

                    rules.push({
                        comment: 'Accept connections to container port range from containership cluster peers',
                        destination_port: `${this.core.scheduler.options.container.min_port}:${this.core.scheduler.options.container.max_port}`,
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        source: peer.address[scope]
                    });
                });
            }
        });

        return rules;
    }

    get_cloud_rules(callback) {
        this.host.getApi().getDistributedKey(constants.myriad.FIREWALLS, (err, firewalls) => {

            const default_firewall = {
                destination_port: '22',
                policy: 'ACCEPT',
                protocol: 'tcp',
                source: '0.0.0.0/0'
            };

            if(err) {
                return callback(err, [ default_firewall ]);
            } else {
                try {
                    firewalls = JSON.parse(firewalls);

                    firewalls = _.map(firewalls, (rule) => {
                        if(rule.type !== 'host' || (rule.host.type === 'mode' && (rule.host.mode === this.host.getOperatingMode() || rule.host.mode === 'all'))) {
                            const new_rule = {
                                comment: rule.description || 'ContainerShip Cloud Firewall Rule',
                                destination_port: rule.port,
                                policy: 'ACCEPT',
                                protocol: rule.protocol
                            };

                            if(rule.interface) {
                                new_rule.interface = rule.interface;
                            }

                            if(rule.source !== '0.0.0.0/0') {
                                new_rule.source = rule.source;
                            }

                            return new_rule;
                        }
                    });

                    return callback(null, _.compact(firewalls));
                } catch(err) {
                    return callback(err, [ default_firewall ]);
                }
            }
        });
    }

    reset_rules(callback) {
        async.series([
            (callback) => {
                // set default policy on INPUT chain to 'ACCEPT'
                this.tesserarius.set_policy('INPUT', 'ACCEPT', callback);
            },
            (callback) => {
                // flush INPUT chain
                this.tesserarius.flush('INPUT', callback);
            },
            (callback) => {
                // flush ContainerShip chain
                this.tesserarius.flush(this.options.chain, (err) => {
                    if(err) {
                        this.tesserarius.create_chain(this.options.chain, callback);
                    } else {
                        return callback();
                    }
                });
            },
            (callback) => {
                // set default ContainerShip chain rules
                this.tesserarius.set_rules(this.options.chain, this.get_initial_rules(), callback);
            },
            (callback) => {
                // add ContainerShip chain to INPUT chain
                this.tesserarius.set_rules('INPUT', [
                    {
                        policy: this.options.chain
                    }
                ], callback);
            },
            (callback) => {
                // set default policy on INPUT chain to 'DROP'
                this.tesserarius.set_policy('INPUT', 'DROP', callback);
            }
        ], callback);
    }

}

module.exports = Firewall;