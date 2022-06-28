import React from 'react';
import Metric from './Metric'


class TopBar extends React.Component {
    constructor(props) {
        super(props);
    }

    render() {
        return (
            <div className="w3-border-bottom">
                <div className="w3-container w3-cell w3-margin w3-padding w3-center">
                    <h1 className="jolt-box">jolt</h1>
                </div>
                <Metric name="In Queue" />
                <Metric name="In Progress" />
                <Metric name="Completed (1h)" />
                <Metric name="Failed (1h)" />
            </div>
        )
    }
}

export default TopBar;
